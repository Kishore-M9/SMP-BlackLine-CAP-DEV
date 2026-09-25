const cds = require('@sap/cds');

module.exports = cds.service.impl(function () {

    const {
        DisbursementPayout
    } = this.entities;

    // Physical Postgres table name, following the same convention already
    // verified for CustomerVirtualAccount ('blackline_customervirtualaccount')
    // — <namespace>_<entity>, lowercased.
    const DP_TABLE = 'blackline_disbursementpayout';


    function normalizeSettlementStatus(settlementStatus) {

        // Optional on input — unset/undefined/null means "unsettled".
        if (
            settlementStatus === undefined ||
            settlementStatus === null
        ) {
            return false;
        }

        return Boolean(settlementStatus);
    }


    function validateMandatoryFields(row) {

        if (
            !row.referenceId ||
            row.amount === undefined ||
            row.amount === null ||
            !row.bankAccountNumber
        ) {
            return 'referenceId, amount and bankAccountNumber are mandatory';
        }

        return null;
    }


    /*
     * Native-UUID-safe insert helper — same approach as
     * insertCustomerVirtualAccount in virtual-account-service.js: a raw
     * INSERT with an explicit ::uuid cast, sidestepping CAP's generated-key
     * insert pipeline, which doesn't play well with a genuine Postgres
     * `uuid` column.
     */
    async function insertDisbursementPayout(data) {

        const id = cds.utils.uuid();

        // Set both timestamps explicitly rather than relying on the
        // column's DB-level default — this raw insert bypasses CAP's
        // managed-field pipeline, and setting them here lets us hand the
        // exact values straight back in the response without a re-read.
        const now = new Date();

        await cds.db.tx(tx =>
            tx.run(
                `INSERT INTO ${DP_TABLE}
                    (id, referenceid, amount, bankaccountnumber, description, settlementstatus, createdat, updatedat)
                 VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $7)`,
                [
                    id,
                    data.referenceId,
                    data.amount,
                    data.bankAccountNumber,
                    data.description ?? null,
                    data.settlementStatus,
                    now
                ]
            )
        );

        return { id, createdAt: now, updatedAt: now };
    }


    /*
     * Builds a dynamic SET clause from whichever fields are actually
     * present on the input (partial-update semantics — same as a
     * standard OData PATCH: omitted fields are left untouched).
     *
     * Returns null if there's nothing to update (no recognized fields
     * supplied besides referenceId), so callers can short-circuit
     * instead of running a no-op UPDATE.
     */
    function buildUpdateSet(data) {

        const columns = [];
        const values = [];
        let paramIndex = 1;

        if (Object.prototype.hasOwnProperty.call(data, 'amount')) {
            columns.push(`amount = $${paramIndex++}`);
            values.push(data.amount);
        }

        if (Object.prototype.hasOwnProperty.call(data, 'bankAccountNumber')) {
            columns.push(`bankaccountnumber = $${paramIndex++}`);
            values.push(data.bankAccountNumber);
        }

        if (Object.prototype.hasOwnProperty.call(data, 'description')) {
            columns.push(`description = $${paramIndex++}`);
            values.push(data.description);
        }

        if (Object.prototype.hasOwnProperty.call(data, 'settlementStatus')) {
            columns.push(`settlementstatus = $${paramIndex++}`);
            values.push(normalizeSettlementStatus(data.settlementStatus));
        }

        if (columns.length === 0) {
            return null;
        }

        columns.push(`updatedat = $${paramIndex++}`);
        values.push(new Date());

        return {
            setClause: columns.join(', '),
            values,
            nextParamIndex: paramIndex
        };
    }


    /*
     * Native-UUID-safe update-by-referenceId helper. Same rationale as
     * insertDisbursementPayout: this bypasses CAP's generic UPDATE
     * pipeline entirely (untested against this schema's uuid column and
     * not worth the risk when the raw-SQL pattern is already the proven
     * approach for every other write path in this file), and looks the
     * row up by the business key (referenceId) rather than the
     * technical ID.
     *
     * Returns the updated row (re-read after the UPDATE), or null if no
     * row matched the given referenceId.
     */
    async function updateByReferenceId(referenceId, data) {

        const built = buildUpdateSet(data);

        if (!built) {
            return { noFieldsToUpdate: true };
        }

        const { setClause, values, nextParamIndex } = built;

        values.push(referenceId);

        const updatedRows = await cds.db.tx(tx =>
            tx.run(
                `UPDATE ${DP_TABLE}
                    SET ${setClause}
                    WHERE referenceid = $${nextParamIndex}
                    RETURNING id, referenceid, amount, bankaccountnumber,
                              description, settlementstatus, createdat, updatedat`,
                values
            )
        );

        // @cap-js/postgres raw tx.run() resolves with the affected row(s)
        // for statements carrying a RETURNING clause — same assumption
        // relied on nowhere else in this file (every other raw statement
        // here is INSERT-only), so this is verified by the row shape
        // check below rather than assumed silently.
        const row =
            Array.isArray(updatedRows)
                ? updatedRows[0]
                : updatedRows;

        if (!row) {
            return null;
        }

        return {
            ID: row.id,
            referenceId: row.referenceid,
            amount: row.amount,
            bankAccountNumber: row.bankaccountnumber,
            description: row.description,
            settlementStatus: row.settlementstatus,
            createdAt: row.createdat,
            updatedAt: row.updatedat
        };
    }


    /*
     * CREATE (single entry)
     * POST /odata/v4/disbursement-payout/DisbursementPayout
     */
    this.before(
        'CREATE',
        'DisbursementPayout',
        req => {

            req.data.settlementStatus =
                normalizeSettlementStatus(
                    req.data.settlementStatus
                );

            const validationError =
                validateMandatoryFields(req.data);

            if (validationError) {
                return req.error(
                    400,
                    validationError
                );
            }
        }
    );


    this.on(
        'CREATE',
        'DisbursementPayout',
        async (req, next) => {

            if (Array.isArray(req.data)) {
                return next();
            }

            const {
                referenceId,
                amount,
                bankAccountNumber,
                description,
                settlementStatus
            } = req.data;

            try {

                const { id, createdAt, updatedAt } =
                    await insertDisbursementPayout({
                        referenceId,
                        amount,
                        bankAccountNumber,
                        description,
                        settlementStatus
                    });

                req.data.ID = id;

                return {
                    ID: id,
                    referenceId,
                    amount,
                    bankAccountNumber,
                    description: description ?? null,
                    settlementStatus,
                    createdAt,
                    updatedAt
                };

            } catch (err) {

                if (err.code === '23505') {

                    return req.error(
                        409,
                        `Duplicate: referenceId '${referenceId}' already exists`
                    );
                }

                throw err;
            }
        }
    );


    /*
     * UPDATE (by technical ID — standard OData PATCH)
     * PATCH /odata/v4/disbursement-payout/DisbursementPayout(<ID>)
     *
     * Kept for standard-OData compatibility, but prefer
     * updateByReferenceId / updateBatch below when the caller only
     * knows the business reference, not the generated UUID. This path
     * still relies on CAP's generic UPDATE pipeline (untested against
     * this schema's native uuid ID column) — see updateByReferenceId's
     * comment for why the new actions use raw SQL instead.
     */
    this.before(
        'UPDATE',
        'DisbursementPayout',
        req => {

            if (
                Object.prototype.hasOwnProperty.call(
                    req.data,
                    'settlementStatus'
                )
            ) {
                req.data.settlementStatus =
                    normalizeSettlementStatus(
                        req.data.settlementStatus
                    );
            }

            req.data.updatedAt = new Date();
        }
    );


    /*
     * UPDATE BY REFERENCE ID (single)
     * POST /odata/v4/disbursement-payout/updateByReferenceId
     *
     * Partial update: only fields actually supplied in the request are
     * changed. referenceId is required and used purely as the lookup
     * key — it is never itself updated.
     */
    this.on(
        'updateByReferenceId',
        async req => {

            const {
                referenceId,
                amount,
                bankAccountNumber,
                description,
                settlementStatus
            } = req.data;

            if (!referenceId) {
                return req.error(
                    400,
                    'referenceId is required'
                );
            }

            const data = {};

            if (amount !== undefined) data.amount = amount;
            if (bankAccountNumber !== undefined) data.bankAccountNumber = bankAccountNumber;
            if (description !== undefined) data.description = description;
            if (settlementStatus !== undefined) data.settlementStatus = settlementStatus;

            const result =
                await updateByReferenceId(referenceId, data);

            if (result && result.noFieldsToUpdate) {
                return req.error(
                    400,
                    'At least one of amount, bankAccountNumber, description or settlementStatus must be supplied'
                );
            }

            if (!result) {
                return req.error(
                    404,
                    `No DisbursementPayout found for referenceId '${referenceId}'`
                );
            }

            return result;
        }
    );


    /*
     * CREATE BATCH
     * POST /odata/v4/disbursement-payout/createBatch
     */
    this.on(
        'createBatch',
        async req => {

            const {
                records
            } = req.data;

            if (
                !Array.isArray(records) ||
                records.length === 0
            ) {
                return req.error(
                    400,
                    'records must be a non-empty array of rows'
                );
            }


            const results = [];


            for (
                let index = 0;
                index < records.length;
                index++
            ) {

                const row = {
                    ...records[index]
                };

                row.settlementStatus =
                    normalizeSettlementStatus(
                        row.settlementStatus
                    );

                try {

                    const validationError =
                        validateMandatoryFields(row);

                    if (validationError) {
                        throw new Error(validationError);
                    }

                    const { id, createdAt, updatedAt } =
                        await insertDisbursementPayout(row);

                    results.push({
                        index,
                        success: true,
                        message: null,
                        ID: id,
                        referenceId: row.referenceId,
                        amount: row.amount,
                        bankAccountNumber: row.bankAccountNumber,
                        description: row.description ?? null,
                        settlementStatus: row.settlementStatus,
                        createdAt,
                        updatedAt
                    });

                } catch (err) {

                    const message =
                        err.code === '23505'
                            ? `Duplicate: referenceId '${row.referenceId}' already exists`
                            : (err.message || 'Failed to create row');

                    results.push({
                        index,
                        success: false,
                        message,
                        ID: null,
                        referenceId: row.referenceId ?? null,
                        amount: row.amount ?? null,
                        bankAccountNumber: row.bankAccountNumber ?? null,
                        description: row.description ?? null,
                        settlementStatus: row.settlementStatus ?? null,
                        createdAt: null,
                        updatedAt: null
                    });
                }
            }


            return results;
        }
    );


    /*
     * UPDATE BATCH
     * POST /odata/v4/disbursement-payout/updateBatch
     *
     * Same referenceId-lookup, partial-update semantics as
     * updateByReferenceId, applied per row. A row with a missing or
     * unknown referenceId is reported as a failed entry in the result
     * array — it does not abort the rest of the batch.
     */
    this.on(
        'updateBatch',
        async req => {

            const {
                records
            } = req.data;

            if (
                !Array.isArray(records) ||
                records.length === 0
            ) {
                return req.error(
                    400,
                    'records must be a non-empty array of rows'
                );
            }


            const results = [];


            for (
                let index = 0;
                index < records.length;
                index++
            ) {

                const row = {
                    ...records[index]
                };

                try {

                    if (!row.referenceId) {
                        throw new Error(
                            'referenceId is required'
                        );
                    }

                    const data = {};

                    if (row.amount !== undefined) data.amount = row.amount;
                    if (row.bankAccountNumber !== undefined) data.bankAccountNumber = row.bankAccountNumber;
                    if (row.description !== undefined) data.description = row.description;
                    if (row.settlementStatus !== undefined) data.settlementStatus = row.settlementStatus;

                    const result =
                        await updateByReferenceId(row.referenceId, data);

                    if (result && result.noFieldsToUpdate) {
                        throw new Error(
                            'At least one of amount, bankAccountNumber, description or settlementStatus must be supplied'
                        );
                    }

                    if (!result) {
                        throw new Error(
                            `No DisbursementPayout found for referenceId '${row.referenceId}'`
                        );
                    }

                    results.push({
                        index,
                        success: true,
                        message: null,
                        ID: result.ID,
                        referenceId: result.referenceId,
                        amount: result.amount,
                        bankAccountNumber: result.bankAccountNumber,
                        description: result.description,
                        settlementStatus: result.settlementStatus,
                        createdAt: result.createdAt,
                        updatedAt: result.updatedAt
                    });

                } catch (err) {

                    results.push({
                        index,
                        success: false,
                        message: err.message || 'Failed to update row',
                        ID: null,
                        referenceId: row.referenceId ?? null,
                        amount: row.amount ?? null,
                        bankAccountNumber: row.bankAccountNumber ?? null,
                        description: row.description ?? null,
                        settlementStatus: row.settlementStatus ?? null,
                        createdAt: null,
                        updatedAt: null
                    });
                }
            }


            return results;
        }
    );


    /*
     * GET UNSETTLED
     * GET /odata/v4/disbursement-payout/getUnsettled()
     */
    this.on(
        'getUnsettled',
        async () => {

            return SELECT
                .from(DisbursementPayout)
                .where({
                    settlementStatus: false
                });
        }
    );

});