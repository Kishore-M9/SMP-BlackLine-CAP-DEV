using { blackline as db } from '../db/schema';

@requires: 'authenticated-user'
service FileMetadataService @(path: '/odata/v4/file-metadata') {

  @odata.draft.enabled: false
  entity FileMetadata as projection on db.FileMetadata;

  // Dedicated input type for bulkInsertFileMetadata. Deliberately excludes
  // ID / createdAt / modifiedAt / createdBy / modifiedBy (managed,
  // server-generated) and delivered / deliveryBatchId / processedAt
  // (server-controlled lifecycle fields) — a client must not be able to
  // set these on create.
  // NOTE: field lengths below are inferred from usage in service.js —
  // confirm against db/schema.cds and adjust if they differ.
  type FileMetadataInput {
    interfaceType    : String(20);
    runId            : String(60);
    docGroupKey      : String(120);
    fileBaseName     : String(255);
    fileType         : String(10);
    status           : String(20);
    docVariant       : String(20);
    // SOA only: BLACKLINE | NON_BL. Omitted / null for every other interface.
    deliveryTarget   : String(20);
    isReprint        : Boolean;
    archivePath      : String(500);
    archived         : Boolean;
    invoiceReference : String(255);   // = db column length; SOA carries several invoice numbers (comma list)
    soaNumber        : String(60);
    errorMsg         : String(1000);
    downloadUrl      : String(1000);
    fileContent      : LargeBinary;
  }

  function pendingCapped(interfaceType: String, limit: Integer) returns array of FileMetadata;

  function pendingCompleteGroups(interfaceType: String, docVariant: String, limit: Integer) returns array of FileMetadata;

  function fullRunReport(interfaceType: String, runId: String) returns array of FileMetadata;

  function deliveryBatchReport(interfaceType: String, deliveryBatchId: String) returns array of FileMetadata;

  // Also returns files that are reprints (never went through delivery) —
  // see the archivePending handler comment in service.js.
  function archivePending(interfaceType: String) returns array of FileMetadata;

  // Reprints (isReprint = true) and corrupted/failed files (status = FAILED)
  // that haven't yet been included in an email report. Used to build the
  // "Reprints" and "Failed / Corrupted" sections of the batch report,
  // independent of whichever run originally produced the row.
  function pendingReportItems(interfaceType: String) returns array of FileMetadata;

  action stampDeliveryBatch(interfaceType: String, deliveryBatchId: String, docGroupKeys: array of String) returns Integer;

  function stuckDeliveries(interfaceType: String) returns array of FileMetadata;

  action bulkInsertFileMetadata(files: array of FileMetadataInput) returns {
    insertedCount : Integer;
    skippedCount  : Integer;
    skippedFiles  : array of String;
  };

  action markDelivered(interfaceType: String, fileBaseName: String, runId: String, deliveryBatchId: String) returns FileMetadata;
  action markDeliveredBulk(interfaceType: String, deliveryBatchId: String, docGroupKeys: array of String) returns Integer;

  action markArchived(interfaceType: String, fileBaseName: String, runId: String, archivePath: String) returns FileMetadata;
  action markArchivedBulk(interfaceType: String, archivePath: String, archiveBatchId: String, docGroupKeys: array of String) returns Integer;

  // Stamps reported = true / reportedBatchId on the given docGroupKeys —
  // called once a reprint/failed-file report email has actually been sent,
  // so the same row never appears in a future report.
  action markReportedBulk(interfaceType: String, reportedBatchId: String, docGroupKeys: array of String) returns Integer;

  // TEMP action to empty FileMetadata entirely — scoped to the service-
  // level 'authenticated-user' (no extra role restriction). Still gated
  // by confirm: true in the handler, but any authenticated caller can
  // invoke it. Remove this action (and the purgeAll handler in
  // service.js) once the one-off cleanup it exists for is done.
  action purgeAll(confirm: Boolean) returns Integer;
}