namespace blackline;

using { cuid } from '@sap/cds/common';

entity FileMetadata : cuid {

    interfaceType : String(20) @mandatory enum {
        INVOICE;
        CREDIT_MEMO;
        SOA;
        ACK_RECEIPT;
    };

    runId           : String(50) @mandatory;
    deliveryBatchId : String(50);
    archiveBatchId  : String(50);

    docGroupKey     : String(255) @mandatory;
    fileBaseName    : String(255) @mandatory;
    fileType        : String(10) @mandatory;

    docVariant      : String(20);

    // SOA only: BLACKLINE | NON_BL (null for every other interface).
    // NON_BL rows are never delivered; archivePending returns them so the
    // Worker can move them - the Worker picks the folder from this field.
    deliveryTarget  : String(20);

    archivePath     : String(500);

    status          : String(20) @mandatory enum {
        VALIDATED;
        SUCCESS;
        FAILED;
    };

    isReprint       : Boolean default false;
    delivered       : Boolean default false;
    archived        : Boolean default false;

    // Reprint / corrupted-file (status = FAILED) email reporting.
    // reported is stamped true, and reportedBatchId set, in the same
    // update that includes a row in an email — so the next run's
    // "what needs reporting" fetch never re-surfaces the same row.
    reported        : Boolean default false;
    reportedBatchId : String(50);

    processedAt     : Timestamp default $now;
    errorMsg        : String(1000);

    invoiceReference : String(255);
    soaNumber        : String(50);

    // Link to where the file can be fetched from (e.g. SharePoint,
    // BlackLine, or an internal archive/blob store URL).
    downloadUrl      : String(1000);

    // Raw file bytes, stored directly in the DB. Client payloads carry
    // this as a base64 string (standard OData/CDS LargeBinary handling);
    // CAP decodes it to a Buffer before handlers run, and the raw-SQL
    // insert paths in file-metadata-service.js bind that Buffer straight
    // to this bytea column.
    fileContent      : LargeBinary;
}


entity CustomerVirtualAccount : cuid {

    virtualAccount : String(30) @mandatory;
    customerNumber : String(20) @mandatory;
    companyCode    : String(10) @mandatory;

    displayName    : String(255);

    landscape      : String(10) enum {
        PRD;
        T4S;
        D4S;
    } default 'PRD';
}


entity DisbursementPayout : cuid {

    referenceId       : String(100) @mandatory;
    amount            : Decimal(15, 2) @mandatory;
    bankAccountNumber : String(50) @mandatory;
    description       : String(500);

    // false/unset = not yet settled ("unsettled"); true = settled.
    // Optional on input — defaults to false (unsettled) when omitted.
    settlementStatus  : Boolean default false;

    createdAt         : Timestamp default $now;
    // DB-level default covers inserts; @cds.on.update also makes any
    // future standard CAP UPDATE (e.g. an OData PATCH) bump this
    // automatically. Our own raw-SQL insert/update paths set it explicitly
    // too — see disbursement-payout-service.js.
    updatedAt         : Timestamp default $now @cds.on.update: $now;
}