const cds = require('@sap/cds');

module.exports = cds.service.impl(function () {

    const { FileMetadata } = this.entities;

    const INTERFACE_TYPES = [
        'INVOICE',
        'CREDIT_MEMO',
        'SOA',
        'ACK_RECEIPT'
    ];

    const STATUS_VALUES = [
        'VALIDATED',
        'SUCCESS',
        'FAILED'
    ];

    // Per-interface reference-field requirements. Previously this was a
    // single flat REFERENCE_INTERFACES list that required BOTH
    // invoiceReference and soaNumber for every interface in it (SOA and
    // ACK_RECEIPT). That was wrong for ACK_RECEIPT: ACK receipts never
    // carry an soaNumber, so every ACK_RECEIPT file was being forced to
    // status = FAILED on insert regardless of how valid it actually was.
    // Now each interface declares exactly which fields it needs.
    const REFERENCE_REQUIREMENTS = {
        SOA: ['invoiceReference', 'soaNumber'],
        ACK_RECEIPT: ['invoiceReference']
    };

    // Interfaces where missing required reference field(s) are NOT a hard
    // reject — the row is still persisted (status forced to FAILED so it
    // can never reach pendingCapped/pendingCompleteGroups, both of which
    // only ever select status = 'VALIDATED'), it just can never be sent to
    // BlackLine. Only ACK_RECEIPT behaves this way today; SOA still hard-
    // rejects (row not inserted at all) via REFERENCE_REQUIREMENTS above.
    const SOFT_REJECT_ON_MISSING_REFERENCE = [
        'ACK_RECEIPT'
    ];

    // SOA only: BlackLine vs Non-BlackLine, set by the SOA Producer from
    // the Profit Center / Segment lookup. null for every other interface.
    //   BLACKLINE -> delivered (pendingCompleteGroups), then archived
    //   NON_BL    -> never delivered; returned by archivePending straight
    //                away so the Worker moves it (to the folder it picks
    //                from this field) and calls markArchivedBulk.
    const DELIVERY_TARGETS = [
        'BLACKLINE',
        'NON_BL'
    ];

    const EXPECTED_FILE_COUNTS = {
        'INVOICE|': 2,
        'CREDIT_MEMO|': 2,
        'ACK_RECEIPT|': 1,
        'SOA|TENANT': 2,
        'SOA|NON_TENANT': 1
    };

    const MAX_BULK_INSERT_SIZE = 500; // guards against unbounded payloads / long-held locks

    // Marker that identifies a reprint purely from the filename, e.g.
    // "20260128-SMAU-INV-0000003476-REPRINT". Case-insensitive.
    // ADJUST THIS if the real naming convention uses a different token
    // (e.g. "_RP", "-RESEND", etc.) or a fixed position/suffix instead
    // of a free substring match.
    const REPRINT_FILENAME_PATTERN = /reprint/i;

    /*
     * isReprint is now determined ENTIRELY by the filename, not by
     * whether a prior row for the same docGroupKey was already
     * delivered. If REPRINT_FILENAME_PATTERN matches fileBaseName,
     * the file is flagged isReprint = true; otherwise it is always
     * false, regardless of delivery history.
     */
    function isReprintFromFileName(fileBaseName) {
        return REPRINT_FILENAME_PATTERN.test(fileBaseName || '');
    }


    /*
     * Returns the list of required reference fields (from
     * REFERENCE_REQUIREMENTS) that are missing/falsy on the given data
     * object, for the given interfaceType. Returns [] for an interface
     * type with no entry in REFERENCE_REQUIREMENTS (i.e. nothing
     * required — INVOICE, CREDIT_MEMO).
     */
    function getMissingReferenceFields(interfaceType, data) {
        const required = REFERENCE_REQUIREMENTS[interfaceType];
        if (!required) return [];
        // SOA: invoiceReference / soaNumber are only needed to build the
        // BlackLine index row, so they are required only for a VALIDATED
        // row going to BlackLine. NON_BL rows and rows the Producer
        // already marks FAILED (errorMsg set) are stored without them.
        // ACK_RECEIPT is unaffected.
        if (interfaceType === 'SOA' &&
            (data.status !== 'VALIDATED' || data.deliveryTarget === 'NON_BL')) {
            return [];
        }
        return required.filter(field => !data[field]);
    }


    /*
     * SOA only: "not NON_BL" (BLACKLINE, or null for rows written before
     * deliveryTarget existed). A fresh CQN expression per call - query
     * builders may mutate the object they are given.
     */
    function soaNotNonBl() {
        return cds.parse.expr`(deliveryTarget is null or deliveryTarget <> 'NON_BL')`;
    }


    /*
     * Defensive base64 -> Buffer conversion for LargeBinary fields.
     * CAP is expected to auto-decode an incoming base64 LargeBinary
     * value into a Buffer before a handler runs, but this was only
     * ever confirmed for entity-level CREATE — a custom action's
     * input type (bulkInsertFileMetadata's FileMetadataInput) may not
     * get the same treatment. Rather than trust either path blindly,
     * every insert path normalizes through this helper: pass through
     * an existing Buffer untouched, decode a string as base64, and
     * treat anything falsy as null.
     */
    function toBuffer(fileContent) {
        if (!fileContent) return null;
        return Buffer.isBuffer(fileContent) ? fileContent : Buffer.from(fileContent, 'base64');
    }


    /*
     * Defensive stream/Buffer -> base64-string normalization for
     * LargeBinary fields on the READ side.
     *
     * Confirmed live: pendingCapped's fileContent came back over
     * OData as the literal text "[object Readable]" — a Node.js
     * Readable stream object (CAP's default representation for a
     * LargeBinary value fetched via a plain SELECT) dumped straight
     * into the JSON response instead of being read and encoded.
     *
     * Explicitly listing the column via .columns('*', 'fileContent')
     * makes @cap-js/postgres wrap it in ENCODE(...,'base64') at the
     * SQL level instead, returning a plain base64 string with nothing
     * left to stream — confirmed via the generated SQL on
     * pendingCompleteGroups. Every handler that exposes fileContent
     * now also runs its result through this helper as a safety net
     * that's correct regardless of which path handed the value back:
     * an existing string (already base64 from ENCODE) passes through
     * untouched, a Buffer is base64-encoded, an actual stream gets
     * read and encoded, and null/undefined stays null.
     */
    async function resolveFileContent(value) {
        if (value == null) return null;
        if (typeof value === 'string') return value;
        if (Buffer.isBuffer(value)) return value.toString('base64');
        if (typeof value.pipe === 'function') {
            const chunks = [];
            for await (const chunk of value) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            return Buffer.concat(chunks).toString('base64');
        }
        return value;
    }


    /*
     * CREATE
     */
    this.before('CREATE', 'FileMetadata', req => {

        const {
            interfaceType,
            runId,
            docGroupKey,
            fileBaseName,
            fileType,
            status
        } = req.data;

        if (
            !interfaceType ||
            !runId ||
            !docGroupKey ||
            !fileBaseName ||
            !fileType ||
            !status
        ) {
            return req.error(
                400,
                'interfaceType, runId, docGroupKey, fileBaseName, fileType and status are mandatory'
            );
        }

        if (!INTERFACE_TYPES.includes(interfaceType)) {
            return req.error(
                400,
                `interfaceType must be one of: ${INTERFACE_TYPES.join(', ')}`
            );
        }

        if (!STATUS_VALUES.includes(status)) {
            return req.error(
                400,
                `status must be one of: ${STATUS_VALUES.join(', ')}`
            );
        }

        if (req.data.deliveryTarget && !DELIVERY_TARGETS.includes(req.data.deliveryTarget)) {
            return req.error(
                400,
                `deliveryTarget must be one of: ${DELIVERY_TARGETS.join(', ')}`
            );
        }

        const missingRefFields = getMissingReferenceFields(interfaceType, req.data);

        if (missingRefFields.length) {
            if (SOFT_REJECT_ON_MISSING_REFERENCE.includes(interfaceType)) {
                // Invalid reference data — force status to FAILED (excludes
                // it from pendingCapped/pendingCompleteGroups, which only
                // select status = 'VALIDATED') but still persist the row so
                // there's a permanent record; it flows into archivePending
                // like any other FAILED file.
                req.data.status = 'FAILED';
                req.data.errorMsg = req.data.errorMsg ||
                    `Missing ${missingRefFields.join(', ')} — ${interfaceType} not valid for delivery`;
            } else {
                return req.error(
                    400,
                    `${missingRefFields.join(' and ')} ${missingRefFields.length > 1 ? 'are' : 'is'} mandatory for ${interfaceType}`
                );
            }
        }

        // isReprint is now derived from the filename, overriding
        // whatever (if anything) the caller passed in req.data.isReprint.
        req.data.isReprint = isReprintFromFileName(fileBaseName);
    });


    /*
     * Native-UUID-safe insert.
     *
     * Same issue as CustomerVirtualAccount: the `id` column in
     * Postgres is a genuine `uuid` type, but @cap-js/postgres never
     * casts the generated key when binding it, so the generic ORM
     * insert (next()) fails with "column id is of type uuid but
     * expression is of type text". We insert with an explicit raw SQL
     * ::uuid cast via cds.db instead - see virtual-account-service.js
     * for the reasoning and the verified working pattern (raw SQL run
     * through cds.db.tx(), NOT this.tx(), which silently no-ops).
     *
     * fileContent is normalized through toBuffer() before binding —
     * see that helper's comment for why this isn't trusted blindly
     * even though CAP is expected to auto-decode base64 LargeBinary
     * entity properties into a Buffer before this handler runs.
     *
     * status/errorMsg here are whatever this.before('CREATE', ...)
     * already settled on (including the missing-reference override
     * above), NOT recomputed — the before-handler always runs first
     * for a single-object CREATE.
     *
     * isReprint here is whatever this.before('CREATE', ...) already
     * derived from the filename (req.data.isReprint), NOT recomputed —
     * the before-handler always runs first for a single-object CREATE.
     *
     * KNOWN GAP — this only covers single-object CREATE. Array-based
     * creates (Array.isArray(req.data) below) fall through to next()
     * unprotected and will hit the same uuid-cast error if that path
     * is ever actually exercised. bulkInsertFileMetadata below is the
     * intended bulk-create path and has its own uuid fix; if anything
     * still POSTs arrays directly to the FileMetadata entity, this
     * branch needs the same raw-SQL treatment.
     *
     * PostgreSQL unique index (if present on your DB):
     * interfaceType + runId + fileBaseName
     */
    this.on('CREATE', 'FileMetadata', async (req, next) => {

        if (Array.isArray(req.data)) {
            return next();
        }

        const {
            interfaceType,
            runId,
            deliveryBatchId,
            docGroupKey,
            fileBaseName,
            fileType,
            docVariant,
            deliveryTarget,
            archivePath,
            status,
            isReprint,
            delivered,
            archived,
            errorMsg,
            invoiceReference,
            soaNumber,
            downloadUrl,
            fileContent
        } = req.data;

        const id = cds.utils.uuid();
        const fileContentBuffer = toBuffer(fileContent);

        try {

            await cds.db.tx(tx =>
                tx.run(
                    `INSERT INTO blackline_filemetadata
                        (id, interfacetype, runid, deliverybatchid, docgroupkey,
                         filebasename, filetype, docvariant, archivepath, status,
                         isreprint, delivered, archived, errormsg,
                         invoicereference, soanumber, downloadurl, filecontent,
                         deliverytarget)
                     VALUES
                        ($1::uuid, $2, $3, $4, $5,
                         $6, $7, $8, $9, $10,
                         $11, $12, $13, $14,
                         $15, $16, $17, $18,
                         $19)`,
                    [
                        id,
                        interfaceType,
                        runId,
                        deliveryBatchId ?? null,
                        docGroupKey,
                        fileBaseName,
                        fileType,
                        docVariant ?? null,
                        archivePath ?? null,
                        status,
                        isReprint ?? false,
                        delivered ?? false,
                        archived ?? false,
                        errorMsg ?? null,
                        invoiceReference ?? null,
                        soaNumber ?? null,
                        downloadUrl ?? null,
                        fileContentBuffer,
                        deliveryTarget ?? null
                    ]
                )
            );

        } catch (err) {

            if (err.code === '23505') {

                return req.error(
                    409,
                    `Duplicate file: interfaceType '${interfaceType}', runId '${runId}', fileBaseName '${fileBaseName}' already exists`
                );
            }

            throw err;
        }

        req.data.ID = id;

        // Re-read the persisted row so the response reflects real DB
        // state (DB-assigned processedAt, defaults, etc.) rather than
        // values we'd have to reconstruct by hand.
        return SELECT.one
            .from(FileMetadata)
            .where({ ID: id });
    });


    /*
     * UPDATE
     */
    this.before('UPDATE', 'FileMetadata', req => {

        if (!req.params?.length && !req.data?.ID) {
            return req.error(
                400,
                'UPDATE requires a key (ID) in the request path'
            );
        }
    });


    /*
     * PENDING CAPPED
     *
     * .columns('*', 'fileContent') + resolveFileContent() added —
     * fileContent was coming back over OData as the literal string
     * "[object Readable]" (an unread stream object dumped into the
     * response) since this query never explicitly requested the
     * column. Now mirrors pendingCompleteGroups's fix: explicit
     * column selection so Postgres does the base64 encoding, plus the
     * defensive helper as a safety net regardless of what comes back.
     *
     * status: 'VALIDATED' below means any row forced to status =
     * 'FAILED' (e.g. missing required reference fields) is
     * automatically excluded — no extra filter needed.
     */
    this.on('pendingCapped', async req => {

        const {
            interfaceType,
            limit
        } = req.data;

        if (!interfaceType) {
            return req.error(
                400,
                'interfaceType is required'
            );
        }

        if (!INTERFACE_TYPES.includes(interfaceType)) {
            return req.error(
                400,
                `interfaceType must be one of: ${INTERFACE_TYPES.join(', ')}`
            );
        }

        // No default cap: if limit is omitted (or not a positive
        // integer), return every matching row instead of capping at
        // 1500.
        const hasLimit =
            Number.isInteger(limit) && limit > 0;

        let query =
            SELECT
                .from(FileMetadata)
                .columns('*', 'fileContent')
                .where({
                    interfaceType,
                    status: 'VALIDATED',
                    delivered: false
                })
                .orderBy('processedAt asc');

        if (hasLimit) {
            query = query.limit(limit);
        }

        const results = await query;

        for (const row of results) {
            row.fileContent = await resolveFileContent(row.fileContent);
        }

        return results;
    });


    /*
     * PENDING COMPLETE GROUPS
     *
     * NOTE: the isReprint = false filter here does NOT change from
     * this update. isReprint is still stored per file and honored
     * elsewhere (pendingReportItems, etc.) — what changed is only
     * WHERE isReprint's true/false value comes from (filename now,
     * not delivery history). If reprints should also flow through
     * this grouping query, remove the isReprint line from `filter`
     * below — that is a separate decision from this filename change.
     *
     * status: 'VALIDATED' below means any row forced to status =
     * 'FAILED' (e.g. missing required reference fields) is
     * automatically excluded from grouping/delivery — no extra
     * filter needed.
     */
    this.on('pendingCompleteGroups', async req => {

        const {
            interfaceType,
            docVariant,
            limit
        } = req.data;

        if (!interfaceType) {
            return req.error(
                400,
                'interfaceType is required'
            );
        }

        if (!INTERFACE_TYPES.includes(interfaceType)) {
            return req.error(
                400,
                `interfaceType must be one of: ${INTERFACE_TYPES.join(', ')}`
            );
        }

        // No default cap: if limit is omitted (or not a positive
        // integer), return every file in every complete group instead
        // of capping at 1500.
        const fileLimit =
            Number.isInteger(limit) && limit > 0
                ? limit
                : null;

        const variantKey = docVariant || '';

        const lookupKey =
            `${interfaceType}|${variantKey}`;

        const expected =
            EXPECTED_FILE_COUNTS[lookupKey];

        if (!expected) {
            return req.error(
                400,
                `No expected file count configured for interfaceType '${interfaceType}'` +
                (variantKey
                    ? `, docVariant '${variantKey}'`
                    : '')
            );
        }

        const filter = {
            interfaceType,
            status: 'VALIDATED',
            delivered: false,
            isReprint: false
        };

        if (variantKey) {
            filter.docVariant = variantKey;
        } else {
            filter.docVariant = null;
        }


        /*
         * Find complete document groups.
         * having('count(*) =', expected) — confirmed working against
         * a real tenant (correctly narrowed to exactly the complete
         * groups), so left exactly as-is.
         */
        let groupQuery = SELECT
            .from(FileMetadata)
            .columns(
                'docGroupKey',
                {
                    func: 'min',
                    args: [
                        {
                            ref: ['processedAt']
                        }
                    ],
                    as: 'earliestTs'
                }
            )
            .where(filter);

        // SOA only: NON_BL pairs are complete groups too, but must never
        // reach the BlackLine ZIP. Other interfaces: query unchanged.
        if (interfaceType === 'SOA') {
            groupQuery = groupQuery.and(soaNotNonBl());
        }

        const groupRows = await groupQuery
            .groupBy('docGroupKey')
            .having('count(*) =', expected)
            .orderBy('earliestTs asc');


        const completeKeys =
            groupRows.map(row => row.docGroupKey);

        if (completeKeys.length === 0) {
            return [];
        }


        /*
         * Fetch all files belonging to complete groups.
         *
         * .columns('*', 'fileContent') — CAP excludes LargeBinary
         * fields from a default/wildcard select to avoid pulling large
         * payloads on every generic read. Without this, candidateFiles
         * rows come back with every field except the one the ZIP
         * builder actually needs.
         *
         * resolveFileContent() added as a safety net alongside the SQL-
         * level ENCODE this already triggers — see that helper's
         * comment (added after the pendingCapped stream bug surfaced).
         */
        let candidateQuery = SELECT
            .from(FileMetadata)
            .columns('*', 'fileContent')
            .where({
                ...filter,
                docGroupKey: {
                    in: completeKeys
                }
            });

        if (interfaceType === 'SOA') {
            candidateQuery = candidateQuery.and(soaNotNonBl());
        }

        const candidateFiles = await candidateQuery
            .orderBy('processedAt asc');

        for (const file of candidateFiles) {
            file.fileContent = await resolveFileContent(file.fileContent);
        }


        /*
         * Keep complete groups together.
         */
        const filesByGroup = {};

        for (const file of candidateFiles) {

            if (!filesByGroup[file.docGroupKey]) {
                filesByGroup[file.docGroupKey] = [];
            }

            filesByGroup[file.docGroupKey].push(file);
        }


        const result = [];

        for (const groupKey of completeKeys) {

            const groupFiles =
                filesByGroup[groupKey] || [];

            if (
                fileLimit !== null &&
                result.length + groupFiles.length >
                fileLimit
            ) {
                break;
            }

            result.push(...groupFiles);
        }

        return result;
    });


    /*
     * FULL RUN REPORT
     */
    this.on('fullRunReport', async req => {

        const {
            interfaceType,
            runId
        } = req.data;

        if (!interfaceType || !runId) {
            return req.error(
                400,
                'interfaceType and runId are required'
            );
        }

        return SELECT
            .from(FileMetadata)
            .where({
                interfaceType,
                runId
            })
            .orderBy('processedAt asc');
    });


    /*
     * DELIVERY BATCH REPORT
     */
    this.on('deliveryBatchReport', async req => {

        const {
            interfaceType,
            deliveryBatchId
        } = req.data;

        if (!interfaceType || !deliveryBatchId) {
            return req.error(
                400,
                'interfaceType and deliveryBatchId are required'
            );
        }

        return SELECT
            .from(FileMetadata)
            .where({
                interfaceType,
                deliveryBatchId
            })
            .orderBy('processedAt asc');
    });


    /*
     * ARCHIVE PENDING
     *
     * Picks up status = 'FAILED' rows in addition to delivered = true
     * or isReprint = true. This was needed so a file forced to FAILED
     * (e.g. missing required reference field(s)) still gets archived
     * even though it will never be delivered — but note this widens
     * archivePending for EVERY FAILED row, including any other file
     * your upstream validation already marks FAILED (e.g. corrupted
     * files). Previously those had no archive path at all; they now
     * flow through the same way. If FAILED-but-not-missing-reference
     * files need different archive handling, split this condition
     * further.
     */
    this.on('archivePending', async req => {

        const {
            interfaceType
        } = req.data;

        if (!interfaceType) {
            return req.error(
                400,
                'interfaceType is required'
            );
        }

        return SELECT
            .from(FileMetadata)
            .where({ interfaceType, archived: false })
            // deliveryTarget = 'NON_BL' is SOA only (null for every other
            // interface, so their result is unchanged). The Worker reads
            // deliveryTarget on each row to pick the target folder and
            // passes it as archivePath to markArchivedBulk.
            .and(cds.parse.expr`delivered = true or isReprint = true or status = 'FAILED' or deliveryTarget = 'NON_BL'`)
            .orderBy('processedAt asc');
    });


    /*
     * PENDING REPORT ITEMS
     *
     * Reprints (isReprint = true) and corrupted/failed files
     * (status = 'FAILED') that haven't yet been surfaced in an email
     * report. reported stays false until markReportedBulk stamps it,
     * so a leftover row from an earlier run that only now gets
     * reported is correctly picked up here — same pattern as
     * archivePending/pendingCapped picking up earlier leftovers by
     * their own not-yet-done flag rather than by run/time window.
     *
     * A file forced to status = 'FAILED' for missing required
     * reference field(s) will surface here too (same status =
     * 'FAILED' condition) — intentional, since it's a case worth
     * reporting on. If it should be excluded from this report, add an
     * explicit isReprint = true or status = 'FAILED' and errorMsg !=
     * <the missing-reference message> condition.
     */
    this.on('pendingReportItems', async req => {

        const { interfaceType } = req.data;

        if (!interfaceType) {
            return req.error(
                400,
                'interfaceType is required'
            );
        }

        return SELECT
            .from(FileMetadata)
            .where({ interfaceType, reported: false })
            .and(cds.parse.expr`isReprint = true or status = 'FAILED'`)
            .orderBy('processedAt asc');
    });


    /*
     * STAMP DELIVERY BATCH
     */
    this.on('stampDeliveryBatch', async req => {

        const {
            interfaceType,
            deliveryBatchId,
            docGroupKeys
        } = req.data;

        if (
            !interfaceType ||
            !deliveryBatchId ||
            !docGroupKeys ||
            !docGroupKeys.length
        ) {
            return req.error(
                400,
                'interfaceType, deliveryBatchId and docGroupKeys are required'
            );
        }

        return UPDATE(FileMetadata)
            .set({ deliveryBatchId })
            .where({
                interfaceType,
                docGroupKey: { in: docGroupKeys },
                delivered: false
            });
    });


    /*
     * STUCK DELIVERIES
     */
    this.on('stuckDeliveries', async req => {

        const { interfaceType } = req.data;

        if (!interfaceType) {
            return req.error(
                400,
                'interfaceType is required'
            );
        }

        return SELECT
            .from(FileMetadata)
            .where({ interfaceType, delivered: false })
            .and('deliveryBatchId is not null')
            .orderBy('processedAt asc');
    });


    /*
     * BULK INSERT
     *
     * isReprint is determined SOLELY by the filename
     * (isReprintFromFileName / REPRINT_FILENAME_PATTERN), not by
     * whether the docGroupKey already has a delivered row.
     *
     * The duplicate-skip logic (pendingDuplicateKeys, based on
     * interfaceType + fileBaseName + fileType where the existing row
     * is NOT yet delivered) is independent of isReprint — that's a
     * separate concern (don't re-insert the same physical file while
     * it's still sitting undelivered) from what value isReprint gets
     * on a fresh insert.
     *
     * A REFERENCE_REQUIREMENTS interface (SOA/ACK_RECEIPT) missing
     * its required field(s) is not always a hard skip. ACK_RECEIPT
     * (see SOFT_REJECT_ON_MISSING_REFERENCE) is instead inserted with
     * status forced to FAILED — kept out of delivery entirely
     * (pendingCapped/pendingCompleteGroups only select status =
     * 'VALIDATED') but still persisted, with errorMsg explaining why,
     * and picked up later by archivePending. SOA still hard-skips
     * (not inserted at all) on a missing required field.
     *
     * NOTE: ACK_RECEIPT only requires invoiceReference — soaNumber is
     * not applicable to this interface and is no longer checked here
     * (see REFERENCE_REQUIREMENTS above).
     */
    this.on('bulkInsertFileMetadata', async req => {

        const { files } = req.data;

        if (!files || !Array.isArray(files) || files.length === 0) {
            return req.error(
                400,
                'files array is required and must not be empty'
            );
        }

        if (files.length > MAX_BULK_INSERT_SIZE) {
            return req.error(
                400,
                `files array exceeds the maximum of ${MAX_BULK_INSERT_SIZE} per call — split into smaller batches`
            );
        }

        const fileBaseNames = [...new Set(files.map(f => f.fileBaseName).filter(Boolean))];

        const pendingDuplicateKeys = new Set();

        if (fileBaseNames.length > 0) {
            // Natural key for "is this literally the same physical file
            // already tracked": interfaceType + fileBaseName + fileType.
            // Deliberately excludes runId, since runId is a fresh value on
            // every ingestion run and would never recognize a re-scan of
            // the same file as the same file.
            const existingRows = await SELECT
                .from(FileMetadata)
                .columns('interfaceType', 'fileBaseName', 'fileType', 'delivered', 'archived')
                .where({ fileBaseName: { in: fileBaseNames } });

            for (const row of existingRows) {
                // SOA: an archived row is finished too (NON_BL / FAILED rows
                // are archived without ever being delivered) - a re-uploaded
                // file with the same name must be accepted again.
                const soaDone = row.interfaceType === 'SOA' && row.archived;
                if (!row.delivered && !soaDone) {
                    pendingDuplicateKeys.add(`${row.interfaceType}|${row.fileBaseName}|${row.fileType}`);
                }
            }
        }

        let insertedCount = 0;
        let skippedCount = 0;
        const skippedFiles = [];
        const seenInThisBatch = new Set();

        for (const file of files) {

            const {
                interfaceType,
                runId,
                docGroupKey,
                fileBaseName,
                fileType,
                status,
                docVariant,
                deliveryTarget,
                archivePath,
                archived,
                invoiceReference,
                soaNumber,
                errorMsg,
                downloadUrl,
                fileContent
            } = file;

            if (
                !interfaceType ||
                !runId ||
                !docGroupKey ||
                !fileBaseName ||
                !fileType ||
                !status
            ) {
                skippedCount++;
                skippedFiles.push(`${fileBaseName || '(missing fileBaseName)'}: missing mandatory field`);
                continue;
            }

            if (
                !INTERFACE_TYPES.includes(interfaceType) ||
                !STATUS_VALUES.includes(status)
            ) {
                skippedCount++;
                skippedFiles.push(`${fileBaseName}: invalid interfaceType or status`);
                continue;
            }

            if (deliveryTarget && !DELIVERY_TARGETS.includes(deliveryTarget)) {
                skippedCount++;
                skippedFiles.push(`${fileBaseName}: invalid deliveryTarget '${deliveryTarget}'`);
                continue;
            }

            // effectiveStatus/effectiveErrorMsg start as whatever the
            // caller sent; the missing-reference block below may
            // override them (for a soft-reject interface) instead of
            // skipping the file.
            let effectiveStatus = status;
            let effectiveErrorMsg = errorMsg || null;

            const missingRefFields = getMissingReferenceFields(interfaceType, file);

            if (missingRefFields.length) {
                if (SOFT_REJECT_ON_MISSING_REFERENCE.includes(interfaceType)) {
                    // Invalid reference data — persist it, but force FAILED
                    // so it can never be picked up for delivery, and record
                    // why.
                    effectiveStatus = 'FAILED';
                    effectiveErrorMsg = effectiveErrorMsg ||
                        `Missing ${missingRefFields.join(', ')} — ${interfaceType} not valid for delivery`;
                } else {
                    skippedCount++;
                    skippedFiles.push(`${fileBaseName}: missing ${missingRefFields.join(', ')}`);
                    continue;
                }
            }

            const naturalKey = `${interfaceType}|${fileBaseName}|${fileType}`;

            // Already tracked and not yet delivered -> the same physical
            // file being re-discovered by a later scan. Skip — inserting
            // again would create a second row for the same invoice and
            // break exact-count group queries like pendingCompleteGroups.
            if (pendingDuplicateKeys.has(naturalKey)) {
                skippedCount++;
                skippedFiles.push(`${fileBaseName}: already exists and not yet delivered — skipped as duplicate`);
                continue;
            }

            // Same file appearing twice within this one call, before either
            // copy exists in the DB yet — the existence check above can't
            // catch this on its own.
            if (seenInThisBatch.has(naturalKey)) {
                skippedCount++;
                skippedFiles.push(`${fileBaseName}: duplicate within this same batch — skipped`);
                continue;
            }
            seenInThisBatch.add(naturalKey);

            // isReprint is decided purely from the filename.
            const isReprint = isReprintFromFileName(fileBaseName);
            const fileContentBuffer = toBuffer(fileContent);

            const id = cds.utils.uuid();

            try {

                await cds.db.tx(tx =>
                    tx.run(
                        `INSERT INTO blackline_filemetadata
                            (id, interfacetype, runid, docgroupkey, filebasename,
                             filetype, docvariant, archivepath, status, isreprint,
                             delivered, archived, errormsg, invoicereference, soanumber,
                             downloadurl, filecontent, deliverytarget)
                         VALUES
                            ($1::uuid, $2, $3, $4, $5,
                             $6, $7, $8, $9, $10,
                             $11, $12, $13, $14, $15,
                             $16, $17, $18)`,
                        [
                            id,
                            interfaceType,
                            runId,
                            docGroupKey,
                            fileBaseName,
                            fileType,
                            docVariant || null,
                            archivePath || null,
                            effectiveStatus,
                            isReprint,
                            false,
                            archived || false,
                            effectiveErrorMsg,
                            invoiceReference || null,
                            soaNumber || null,
                            downloadUrl || null,
                            fileContentBuffer,
                            deliveryTarget || null
                        ]
                    )
                );

                insertedCount++;

            } catch (err) {

                if (err.code !== '23505') {
                    console.error(
                        `bulkInsertFileMetadata: unexpected error on file '${fileBaseName}' (interfaceType '${interfaceType}', runId '${runId}'):`,
                        err
                    );
                }

                skippedCount++;
                skippedFiles.push(`${fileBaseName}: ${err.code === '23505' ? 'duplicate' : err.message}`);
            }
        }

        return { insertedCount, skippedCount, skippedFiles };
    });


    /*
     * MARK DELIVERED
     */
    this.on('markDelivered', async req => {

        const {
            interfaceType,
            fileBaseName,
            runId,
            deliveryBatchId
        } = req.data;

        if (
            !interfaceType ||
            !fileBaseName ||
            !runId
        ) {
            return req.error(
                400,
                'interfaceType, fileBaseName and runId are required'
            );
        }

        const affected =
            await UPDATE(FileMetadata)
                .set({
                    delivered: true,
                    deliveryBatchId:
                        deliveryBatchId || null
                })
                .where({
                    interfaceType,
                    fileBaseName,
                    runId
                });

        if (!affected) {
            return req.error(
                404,
                `No FileMetadata found for interfaceType '${interfaceType}', fileBaseName '${fileBaseName}', runId '${runId}'`
            );
        }

        return SELECT.one
            .from(FileMetadata)
            .where({
                interfaceType,
                fileBaseName,
                runId
            });
    });

    /*
     * MARK DELIVERED — BULK
     *
     * Added for high-volume runs. Updates every row across the given
     * docGroupKeys in one statement instead of one call per file.
     *
     * NOTE (pre-existing, not changed here): this WHERE clause does not
     * filter on isReprint. If a reprint row shares a docGroupKey with a
     * group that's mid-delivery, it will be marked delivered = true here
     * even though pendingCompleteGroups never included it in the actual
     * zip sent to BlackLine. Flagging this as a separate follow-up.
     */
    this.on('markDeliveredBulk', async req => {

        const {
            interfaceType,
            deliveryBatchId,
            docGroupKeys
        } = req.data;

        if (
            !interfaceType ||
            !deliveryBatchId ||
            !docGroupKeys ||
            !docGroupKeys.length
        ) {
            return req.error(
                400,
                'interfaceType, deliveryBatchId and docGroupKeys are required'
            );
        }

        const affected = await UPDATE(FileMetadata)
            .set({ delivered: true, deliveryBatchId })
            .where({
                interfaceType,
                docGroupKey: { in: docGroupKeys }
            });

        return affected;
    });


    /*
     * MARK ARCHIVED — BULK
     *
     * Same reasoning as markDeliveredBulk. archivePath is the shared
     * archive directory applied to every matched row. archiveBatchId is
     * also persisted in the same update — an audit trail of exactly
     * which run archived a given row, independent of any in-memory
     * report list.
     */
    this.on('markArchivedBulk', async req => {

        const {
            interfaceType,
            archivePath,
            archiveBatchId,
            docGroupKeys
        } = req.data;

        if (
            !interfaceType ||
            !archivePath ||
            !docGroupKeys ||
            !docGroupKeys.length
        ) {
            return req.error(
                400,
                'interfaceType, archivePath and docGroupKeys are required'
            );
        }

        const affected = await UPDATE(FileMetadata)
            .set({ archived: true, archivePath, archiveBatchId: archiveBatchId || null })
            .where({
                interfaceType,
                docGroupKey: { in: docGroupKeys }
            });

        return affected;
    });


    /*
     * MARK REPORTED — BULK
     *
     * Stamps reported = true / reportedBatchId on the given docGroupKeys,
     * once an email report has actually included them. Used for the
     * reprint / corrupted-file (status = FAILED) reporting flow fed by
     * pendingReportItems — same idempotent, run-independent pattern as
     * markDeliveredBulk/markArchivedBulk.
     */
    this.on('markReportedBulk', async req => {

        const {
            interfaceType,
            reportedBatchId,
            docGroupKeys
        } = req.data;

        if (
            !interfaceType ||
            !reportedBatchId ||
            !docGroupKeys ||
            !docGroupKeys.length
        ) {
            return req.error(
                400,
                'interfaceType, reportedBatchId and docGroupKeys are required'
            );
        }

        const affected = await UPDATE(FileMetadata)
            .set({ reported: true, reportedBatchId })
            .where({
                interfaceType,
                docGroupKey: { in: docGroupKeys }
            });

        return affected;
    });

    /*
     * MARK ARCHIVED
     */
    this.on('markArchived', async req => {

        const {
            interfaceType,
            fileBaseName,
            runId,
            archivePath
        } = req.data;

        if (
            !interfaceType ||
            !fileBaseName ||
            !runId
        ) {
            return req.error(
                400,
                'interfaceType, fileBaseName and runId are required'
            );
        }

        const affected =
            await UPDATE(FileMetadata)
                .set({
                    archived: true,
                    archivePath:
                        archivePath || null
                })
                .where({
                    interfaceType,
                    fileBaseName,
                    runId
                });

        if (!affected) {
            return req.error(
                404,
                `No FileMetadata found for interfaceType '${interfaceType}', fileBaseName '${fileBaseName}', runId '${runId}'`
            );
        }

        return SELECT.one
            .from(FileMetadata)
            .where({
                interfaceType,
                fileBaseName,
                runId
            });
    });


    /*
     * PURGE ALL — TEMP
     */
    this.on('purgeAll', async req => {

        const { confirm } = req.data;

        if (confirm !== true) {
            return req.error(
                400,
                'purgeAll requires confirm: true — this deletes every FileMetadata row across all interfaceTypes'
            );
        }

        const [{ count }] = await cds.db.tx(async tx => {

            const [row] = await tx.run(
                'SELECT COUNT(*) AS count FROM blackline_filemetadata'
            );

            await tx.run('TRUNCATE TABLE blackline_filemetadata');

            return [row];
        });

        return Number(count);
    });

});