using { blackline as db } from '../db/schema';

@requires: 'authenticated-user'
service DisbursementPayoutService @(path: '/odata/v4/disbursement-payout') {

    // Single-entry POST goes through this entity's standard OData CREATE
    // (POST /odata/v4/disbursement-payout/DisbursementPayout).
    @odata.draft.enabled: false
    entity DisbursementPayout
        as projection on db.DisbursementPayout;


    type DisbursementPayoutInput {

        referenceId       : String(100);
        amount            : Decimal(15, 2);
        bankAccountNumber : String(50);
        description       : String(500);
        settlementStatus  : Boolean;
    }


    type DisbursementPayoutBatchResult {

        index             : Integer;
        success           : Boolean;
        message           : String;

        ID                : UUID;
        referenceId       : String(100);
        amount            : Decimal(15, 2);
        bankAccountNumber : String(50);
        description       : String(500);
        settlementStatus  : Boolean;
        createdAt         : Timestamp;
        updatedAt         : Timestamp;
    }


    // Input for updateByReferenceId / updateBatch. referenceId is the
    // lookup key (mandatory) — every other field is optional, and only
    // the ones actually supplied on a given call get updated (partial
    // update, same semantics as a standard OData PATCH).
    type DisbursementPayoutUpdateInput {

        referenceId       : String(100);
        amount            : Decimal(15, 2);
        bankAccountNumber : String(50);
        description       : String(500);
        settlementStatus  : Boolean;
    }


    // Batch POST — insert many rows in one call.
    action createBatch(
        records : many DisbursementPayoutInput
    ) returns many DisbursementPayoutBatchResult;


    // Single update, looked up by referenceId instead of the technical
    // ID key — use this instead of PATCH /DisbursementPayout(<ID>) when
    // the caller only knows the business reference, not the generated
    // UUID. Only the fields actually supplied are updated.
    action updateByReferenceId(
        referenceId       : String(100),
        amount            : Decimal(15, 2),
        bankAccountNumber : String(50),
        description       : String(500),
        settlementStatus  : Boolean
    ) returns DisbursementPayout;


    // Batch update — same referenceId-lookup semantics as
    // updateByReferenceId, applied per row. Rows with an unknown
    // referenceId, or missing referenceId entirely, are reported as
    // failed in the result array rather than aborting the whole batch.
    action updateBatch(
        records : many DisbursementPayoutUpdateInput
    ) returns many DisbursementPayoutBatchResult;


    // Fetches every DisbursementPayout row currently unsettled
    // (settlementStatus = false), for the "past unsettled check" flow.
    function getUnsettled() returns many DisbursementPayout;
}
