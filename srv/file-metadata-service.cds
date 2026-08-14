using { blackline as db } from '../db/schema';

@requires: 'authenticated-user'
service FileMetadataService @(path: '/odata/v4/file-metadata') {

    @odata.draft.enabled: false
    entity FileMetadata as projection on db.FileMetadata;

    function pendingCapped(
        interfaceType : String,
        limit         : Integer
    ) returns array of FileMetadata;

    function pendingCompleteGroups(
        interfaceType : String,
        docVariant    : String,
        limit         : Integer
    ) returns array of FileMetadata;

    function fullRunReport(
        interfaceType : String,
        runId         : String
    ) returns array of FileMetadata;

    function deliveryBatchReport(
        interfaceType   : String,
        deliveryBatchId : String
    ) returns array of FileMetadata;

    function archivePending(
        interfaceType : String
    ) returns array of FileMetadata;

    action markDelivered(
        interfaceType   : String,
        fileBaseName    : String,
        runId           : String,
        deliveryBatchId : String
    ) returns FileMetadata;

    action markArchived(
        interfaceType : String,
        fileBaseName    : String,
        runId           : String,
        archivePath     : String
    ) returns FileMetadata;


    action purgeAll() returns Integer;
}
