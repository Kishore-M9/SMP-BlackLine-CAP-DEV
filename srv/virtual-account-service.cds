using { blackline as db } from '../db/schema';

@requires: 'authenticated-user'
service VirtualAccountService @(path: '/odata/v4/virtual-account') {

    @odata.draft.enabled: false
    entity CustomerVirtualAccount
        as projection on db.CustomerVirtualAccount;


    type CustomerVirtualAccountLookupResult {

        found          : Boolean;
        message        : String;

        ID             : UUID;
        virtualAccount : String(30);
        customerNumber : String(20);
        companyCode    : String(10);
        displayName    : String(255);
        landscape      : String(10);
    }


    type CustomerVirtualAccountInput {

        virtualAccount : String(30);
        customerNumber : String(20);
        companyCode    : String(10);
        displayName    : String(255);
        landscape      : String(10);
    }


    type CustomerVirtualAccountBatchResult {

        index          : Integer;
        success        : Boolean;
        message        : String;

        ID             : UUID;
        virtualAccount : String(30);
        customerNumber : String(20);
        companyCode    : String(10);
        displayName    : String(255);
        landscape      : String(10);
    }


    function getByVirtualAccount(
        virtualAccount : String,
        landscape      : String
    ) returns CustomerVirtualAccountLookupResult;


    // Fetches every CustomerVirtualAccount row stored in Postgres.
    // Pass `landscape` to restrict to one landscape (PRD/T4S/D4S);
    // omit/leave blank to return rows across all landscapes.
    function getAllVirtualAccounts(
        landscape : String
    ) returns many CustomerVirtualAccount;


    function getByCustomer(
        customerNumber : String,
        companyCode    : String,
        landscape      : String
    ) returns CustomerVirtualAccountLookupResult;


    action createBatch(
        records : many CustomerVirtualAccountInput
    ) returns many CustomerVirtualAccountBatchResult;
}