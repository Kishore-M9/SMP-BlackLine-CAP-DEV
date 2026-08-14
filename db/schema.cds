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

    docGroupKey     : String(255) @mandatory;
    fileBaseName    : String(255) @mandatory;
    fileType        : String(10) @mandatory;

    docVariant      : String(20);

    archivePath     : String(500);

    status          : String(20) @mandatory enum {
        VALIDATED;
        SUCCESS;
        FAILED;
    };

    isReprint       : Boolean default false;
    delivered       : Boolean default false;
    archived        : Boolean default false;

    processedAt     : Timestamp default $now;
    errorMsg        : String(1000);

    invoiceReference : String(255);
    soaNumber        : String(50);
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