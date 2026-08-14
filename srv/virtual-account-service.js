const cds = require('@sap/cds');

module.exports = cds.service.impl(function () {

    const {
        CustomerVirtualAccount
    } = this.entities;

    const LANDSCAPES = [
        'PRD',
        'T4S',
        'D4S'
    ];

    // Physical Postgres table/column names, as actually deployed by this
    // CDS model (verified directly against the DB - see notes below).
    const CVA_TABLE = 'blackline_customervirtualaccount';


    function normalizeLandscape(landscape) {

        if (
            landscape === undefined ||
            landscape === null ||
            landscape.trim() === ''
        ) {
            return 'PRD';
        }

        return landscape.trim().toUpperCase();
    }


    function validateLandscape(landscape) {

        if (!LANDSCAPES.includes(landscape)) {
            return `landscape must be one of: ${LANDSCAPES.join(', ')} (or omitted/empty, which defaults to PRD)`;
        }

        return null;
    }


    function foundResult(row) {

        return {
            found: true,
            message: null,
            ID: row.ID,
            virtualAccount: row.virtualAccount,
            customerNumber: row.customerNumber,
            companyCode: row.companyCode,
            displayName: row.displayName,
            landscape: row.landscape
        };
    }


    function notFoundResult(message) {

        return {
            found: false,
            message,
            ID: null,
            virtualAccount: null,
            customerNumber: null,
            companyCode: null,
            displayName: null,
            landscape: null
        };
    }


    /*
     * Native-UUID-safe insert helper.
     *
     * The `id` column in Postgres is a genuine `uuid` type, but
     * @cap-js/postgres always binds/streams generated keys without an
     * explicit cast (it maps CDS UUID -> VARCHAR(36) internally), which
     * a real `uuid` column rejects. A plain, explicit raw INSERT with
     * an ::uuid cast sidesteps CAP's insert pipeline entirely (both the
     * old per-column parameter binding AND the newer JSON-streamed
     * insert mechanism), so it isn't sensitive to internal changes in
     * how @cap-js/db-service builds INSERT statements between versions.
     *
     * Verified directly against a live Postgres instance with this
     * exact table shape - see the accompanying chat message for the
     * INSERT/SELECT round-trip proof.
     */
    async function insertCustomerVirtualAccount(data) {

        const id = cds.utils.uuid();

        await cds.db.tx(tx =>
            tx.run(
                `INSERT INTO ${CVA_TABLE}
                    (id, virtualaccount, customernumber, companycode, displayname, landscape)
                 VALUES ($1::uuid, $2, $3, $4, $5, $6)`,
                [
                    id,
                    data.virtualAccount,
                    data.customerNumber,
                    data.companyCode,
                    data.displayName ?? null,
                    data.landscape
                ]
            )
        );

        return id;
    }


    /*
     * CREATE
     */
    this.before(
        'CREATE',
        'CustomerVirtualAccount',
        req => {

            req.data.landscape =
                normalizeLandscape(
                    req.data.landscape
                );

            const {
                virtualAccount,
                customerNumber,
                companyCode,
                landscape
            } = req.data;

            if (
                !virtualAccount ||
                !customerNumber ||
                !companyCode
            ) {
                return req.error(
                    400,
                    'virtualAccount, customerNumber and companyCode are mandatory'
                );
            }

            const landscapeError =
                validateLandscape(landscape);

            if (landscapeError) {
                return req.error(
                    400,
                    landscapeError
                );
            }
        }
    );


    this.on(
        'CREATE',
        'CustomerVirtualAccount',
        async (req, next) => {

            if (Array.isArray(req.data)) {
                return next();
            }

            const {
                virtualAccount,
                customerNumber,
                companyCode,
                displayName,
                landscape
            } = req.data;

            try {

                const id =
                    await insertCustomerVirtualAccount({
                        virtualAccount,
                        customerNumber,
                        companyCode,
                        displayName,
                        landscape
                    });

                req.data.ID = id;

                return {
                    ID: id,
                    virtualAccount,
                    customerNumber,
                    companyCode,
                    displayName: displayName ?? null,
                    landscape
                };

            } catch (err) {

                if (err.code === '23505') {

                    return req.error(
                        409,
                        `Duplicate: virtualAccount '${virtualAccount}' already exists for landscape '${landscape}'`
                    );
                }

                throw err;
            }
        }
    );


    /*
     * UPDATE
     */
    this.before(
        'UPDATE',
        'CustomerVirtualAccount',
        req => {

            if (
                !req.params?.length &&
                !req.data?.ID
            ) {
                return req.error(
                    400,
                    'UPDATE requires a key (ID) in the request path'
                );
            }

            if (
                Object.prototype.hasOwnProperty.call(
                    req.data,
                    'landscape'
                )
            ) {
                req.data.landscape =
                    normalizeLandscape(
                        req.data.landscape
                    );

                const landscapeError =
                    validateLandscape(
                        req.data.landscape
                    );

                if (landscapeError) {
                    return req.error(
                        400,
                        landscapeError
                    );
                }
            }
        }
    );


    /*
     * GET BY VIRTUAL ACCOUNT
     */
    this.on(
        'getByVirtualAccount',
        async req => {

            const {
                virtualAccount
            } = req.data;

            const landscape =
                normalizeLandscape(
                    req.data.landscape
                );

            if (!virtualAccount) {
                return req.error(
                    400,
                    'virtualAccount is required'
                );
            }

            const landscapeError =
                validateLandscape(landscape);

            if (landscapeError) {
                return req.error(
                    400,
                    landscapeError
                );
            }

            const result =
                await SELECT.one
                    .from(CustomerVirtualAccount)
                    .where({
                        virtualAccount,
                        landscape
                    });

            if (!result) {

                return notFoundResult(
                    `No CustomerVirtualAccount found for virtualAccount '${virtualAccount}', landscape '${landscape}'`
                );
            }

            return foundResult(result);
        }
    );


    /*
     * GET BY CUSTOMER
     */
    this.on(
        'getByCustomer',
        async req => {

            const {
                customerNumber,
                companyCode
            } = req.data;

            const landscape =
                normalizeLandscape(
                    req.data.landscape
                );

            if (
                !customerNumber ||
                !companyCode
            ) {
                return req.error(
                    400,
                    'customerNumber and companyCode are required'
                );
            }

            const landscapeError =
                validateLandscape(landscape);

            if (landscapeError) {
                return req.error(
                    400,
                    landscapeError
                );
            }

            const result =
                await SELECT.one
                    .from(CustomerVirtualAccount)
                    .where({
                        customerNumber,
                        companyCode,
                        landscape
                    });

            if (!result) {

                return notFoundResult(
                    `No CustomerVirtualAccount found for customer '${customerNumber}', landscape '${landscape}'`
                );
            }

            return foundResult(result);
        }
    );



    /*
     * CREATE BATCH
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

                row.landscape =
                    normalizeLandscape(
                        row.landscape
                    );

                try {

                    if (
                        !row.virtualAccount ||
                        !row.customerNumber ||
                        !row.companyCode
                    ) {
                        throw new Error(
                            'virtualAccount, customerNumber and companyCode are mandatory'
                        );
                    }

                    const landscapeError =
                        validateLandscape(
                            row.landscape
                        );

                    if (landscapeError) {
                        throw new Error(landscapeError);
                    }

                    const id =
                        await insertCustomerVirtualAccount(row);

                    results.push({
                        index,
                        success: true,
                        message: null,
                        ID: id,
                        virtualAccount: row.virtualAccount,
                        customerNumber: row.customerNumber,
                        companyCode: row.companyCode,
                        displayName: row.displayName ?? null,
                        landscape: row.landscape
                    });

                } catch (err) {

                    const message =
                        err.code === '23505'
                            ? `Duplicate: virtualAccount '${row.virtualAccount}' already exists for landscape '${row.landscape}'`
                            : (err.message || 'Failed to create row');

                    results.push({
                        index,
                        success: false,
                        message,
                        ID: null,
                        virtualAccount: row.virtualAccount ?? null,
                        customerNumber: row.customerNumber ?? null,
                        companyCode: row.companyCode ?? null,
                        displayName: row.displayName ?? null,
                        landscape: row.landscape ?? null
                    });
                }
            }


            return results;
        }
    );

});