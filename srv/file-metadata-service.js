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

    const REFERENCE_INTERFACES = [
        'SOA',
        'ACK_RECEIPT'
    ];

    const EXPECTED_FILE_COUNTS = {
        'INVOICE|': 2,
        'CREDIT_MEMO|': 2,
        'ACK_RECEIPT|': 1,
        'SOA|TENANT': 2,
        'SOA|NON_TENANT': 1
    };


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
            status,
            invoiceReference,
            soaNumber
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

        if (
            REFERENCE_INTERFACES.includes(interfaceType) &&
            (!invoiceReference || !soaNumber)
        ) {
            return req.error(
                400,
                'invoiceReference and soaNumber are mandatory for SOA and ACK_RECEIPT'
            );
        }
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
            archivePath,
            status,
            isReprint,
            delivered,
            archived,
            errorMsg,
            invoiceReference,
            soaNumber
        } = req.data;

        const id = cds.utils.uuid();

        try {

            await cds.db.tx(tx =>
                tx.run(
                    `INSERT INTO blackline_filemetadata
                        (id, interfacetype, runid, deliverybatchid, docgroupkey,
                         filebasename, filetype, docvariant, archivepath, status,
                         isreprint, delivered, archived, errormsg,
                         invoicereference, soanumber)
                     VALUES
                        ($1::uuid, $2, $3, $4, $5,
                         $6, $7, $8, $9, $10,
                         $11, $12, $13, $14,
                         $15, $16)`,
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
                        soaNumber ?? null
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
                .where({
                    interfaceType,
                    status: 'VALIDATED',
                    delivered: false
                })
                .orderBy('processedAt asc');

        if (hasLimit) {
            query = query.limit(limit);
        }

        return query;
    });


    /*
     * PENDING COMPLETE GROUPS
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
         */
        const groupRows = await SELECT
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
            .where(filter)
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
         */
        const candidateFiles = await SELECT
            .from(FileMetadata)
            .where({
                ...filter,
                docGroupKey: {
                    in: completeKeys
                }
            })
            .orderBy('processedAt asc');


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
            .where({
                interfaceType,
                delivered: true,
                archived: false
            })
            .orderBy('processedAt asc');
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
     *
     * One-off admin action to empty the FileMetadata table entirely.
     * Uses cds.db.tx() + raw SQL (TRUNCATE), same pattern as the CREATE
     * handler above, since that's the verified-working way to run raw
     * SQL against this app's bound Postgres instance.
     *
     * Remove this handler (and the `purgeAll` action declaration in
     * file-metadata-service.cds) once the cleanup is done - this is
     * not meant to stay in the service long-term.
     */
    this.on('purgeAll', async req => {

        const [{ count }] = await cds.db.tx(tx =>
            tx.run('SELECT COUNT(*) AS count FROM blackline_filemetadata')
        );

        if (Number(count) === 0) {
            return 0;
        }

        await cds.db.tx(tx =>
            tx.run('TRUNCATE TABLE blackline_filemetadata')
        );

        return Number(count);
    });

});