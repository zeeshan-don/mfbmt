CREATE TABLE "public"."SalesOrder" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT '__unset__',
    "orderNumber" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ORDER_CONFIRMED',
    "enquiryId" TEXT,
    "quotationId" TEXT NOT NULL,
    "quotationVersion" INTEGER NOT NULL,
    "customerId" TEXT,
    "customerName" TEXT NOT NULL,
    "customerEmail" TEXT,
    "customerPhone" TEXT,
    "customerPoNumber" TEXT,
    "customerPoReference" TEXT,
    "acceptanceSource" TEXT NOT NULL DEFAULT 'CUSTOMER_PO',
    "acceptanceEvidenceJson" TEXT NOT NULL DEFAULT '{}',
    "resolutionJson" TEXT NOT NULL DEFAULT '{}',
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedById" TEXT,
    "currency" TEXT NOT NULL,
    "subtotal" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "paymentTerms" TEXT,
    "deliveryTerms" TEXT,
    "deliveryAddress" TEXT,
    "agreedDeliveryDate" TIMESTAMP(3),
    "notes" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "closureNote" TEXT,
    "closureOverrideById" TEXT,
    "closureOverrideReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SalesOrderLine" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT '__unset__',
    "salesOrderId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "enquiryItemId" TEXT,
    "customerQuotationItemId" TEXT,
    "productId" TEXT,
    "supplierOfferId" TEXT,
    "description" TEXT NOT NULL,
    "specs" TEXT,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'pcs',
    "unitPrice" DECIMAL(18,4) NOT NULL,
    "discountPct" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "discountAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "taxRatePct" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "stockQuantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "procureQuantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PurchaseOrder" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT '__unset__',
    "poNumber" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'AWAITING_APPROVAL',
    "salesOrderId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "subtotal" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "paymentTerms" TEXT,
    "deliveryTerms" TEXT,
    "deliveryLocation" TEXT,
    "expectedDeliveryDate" TIMESTAMP(3),
    "supplierNotes" TEXT,
    "internalNotes" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "sentChannel" TEXT,
    "sentTo" TEXT,
    "providerMessageId" TEXT,
    "sentSubject" TEXT,
    "sentDocumentJson" TEXT,
    "lastError" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PurchaseOrderLine" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT '__unset__',
    "purchaseOrderId" TEXT NOT NULL,
    "salesOrderLineId" TEXT NOT NULL,
    "supplierOfferId" TEXT,
    "lineNo" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "specs" TEXT,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'pcs',
    "unitPrice" DECIMAL(18,4) NOT NULL,
    "taxRatePct" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "moq" DECIMAL(18,4),
    "leadTimeDays" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SupplierAcknowledgement" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT '__unset__',
    "purchaseOrderId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "reviewStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "promisedDate" TIMESTAMP(3),
    "linesJson" TEXT NOT NULL DEFAULT '[]',
    "deviationsJson" TEXT NOT NULL DEFAULT '[]',
    "notes" TEXT,
    "evidenceJson" TEXT NOT NULL DEFAULT '{}',
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "recordedById" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierAcknowledgement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."GoodsReceipt" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT '__unset__',
    "receiptNumber" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveryNoteRef" TEXT,
    "condition" TEXT NOT NULL DEFAULT 'OK',
    "inspectionResult" TEXT,
    "notes" TEXT,
    "photoPath" TEXT,
    "recordedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoodsReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."GoodsReceiptLine" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT '__unset__',
    "goodsReceiptId" TEXT NOT NULL,
    "purchaseOrderLineId" TEXT NOT NULL,
    "quantityOrdered" DECIMAL(18,4) NOT NULL,
    "quantityReceived" DECIMAL(18,4) NOT NULL,
    "quantityAccepted" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "quantityRejected" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "batchNo" TEXT,
    "condition" TEXT NOT NULL DEFAULT 'OK',
    "inspectionResult" TEXT,
    "discrepancyType" TEXT,
    "discrepancyNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoodsReceiptLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Delivery" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT '__unset__',
    "deliveryNumber" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "salesOrderId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DISPATCHED',
    "dispatchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "carrier" TEXT,
    "vehicleRef" TEXT,
    "trackingRef" TEXT,
    "deliveryAddress" TEXT,
    "proofOfDeliveryPath" TEXT,
    "receivedBy" TEXT,
    "notes" TEXT,
    "recordedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."DeliveryLine" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT '__unset__',
    "deliveryId" TEXT NOT NULL,
    "salesOrderLineId" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CustomerInvoice" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT '__unset__',
    "invoiceNumber" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "salesOrderId" TEXT NOT NULL,
    "customerId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ISSUED',
    "invoiceDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueDate" TIMESTAMP(3),
    "currency" TEXT NOT NULL,
    "subtotal" DECIMAL(18,4) NOT NULL,
    "discountTotal" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(18,4) NOT NULL,
    "taxLabel" TEXT,
    "taxRatePct" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,4) NOT NULL,
    "amountPaid" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "deliveryId" TEXT,
    "notes" TEXT,
    "issuedById" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CustomerInvoiceLine" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT '__unset__',
    "invoiceId" TEXT NOT NULL,
    "salesOrderLineId" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'pcs',
    "unitPrice" DECIMAL(18,4) NOT NULL,
    "discountPct" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "discountAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "taxRatePct" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(18,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerInvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CustomerPayment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT '__unset__',
    "paymentNumber" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "customerId" TEXT,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "method" TEXT NOT NULL DEFAULT 'BANK_TRANSFER',
    "reference" TEXT,
    "proofPath" TEXT,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'CONFIRMED',
    "recordedById" TEXT,
    "reversedById" TEXT,
    "reversedAt" TIMESTAMP(3),
    "reversalReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PaymentAllocation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT '__unset__',
    "paymentId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SupplierBill" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT '__unset__',
    "billNumber" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "purchaseOrderId" TEXT,
    "goodsReceiptId" TEXT,
    "supplierInvoiceRef" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "currency" TEXT NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "taxAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,4) NOT NULL,
    "paidAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "dueDate" TIMESTAMP(3),
    "paymentTerms" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "recordedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierBill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SupplierPayment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT '__unset__',
    "paymentNumber" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "supplierBillId" TEXT NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "method" TEXT NOT NULL DEFAULT 'BANK_TRANSFER',
    "reference" TEXT,
    "proofPath" TEXT,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'CONFIRMED',
    "recordedById" TEXT,
    "reversedById" TEXT,
    "reversedAt" TIMESTAMP(3),
    "reversalReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."OrderStatusEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT '__unset__',
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "reason" TEXT,
    "actorId" TEXT,
    "actorLabel" TEXT NOT NULL DEFAULT 'system',
    "metaJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "salesOrderId" TEXT,

    CONSTRAINT "OrderStatusEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."OrderDiscrepancy" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT '__unset__',
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "salesOrderId" TEXT,
    "code" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'BLOCKING',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "detailJson" TEXT NOT NULL DEFAULT '{}',
    "note" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderDiscrepancy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SalesOrder_organizationId_status_idx" ON "public"."SalesOrder"("organizationId", "status");

-- CreateIndex
CREATE INDEX "SalesOrder_quotationId_idx" ON "public"."SalesOrder"("quotationId");

-- CreateIndex
CREATE INDEX "SalesOrder_customerId_idx" ON "public"."SalesOrder"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrder_organizationId_orderNumber_key" ON "public"."SalesOrder"("organizationId", "orderNumber");

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrder_organizationId_idempotencyKey_key" ON "public"."SalesOrder"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "SalesOrderLine_organizationId_salesOrderId_idx" ON "public"."SalesOrderLine"("organizationId", "salesOrderId");

-- CreateIndex
CREATE INDEX "SalesOrderLine_enquiryItemId_idx" ON "public"."SalesOrderLine"("enquiryItemId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrderLine_salesOrderId_lineNo_key" ON "public"."SalesOrderLine"("salesOrderId", "lineNo");

-- CreateIndex
CREATE INDEX "PurchaseOrder_organizationId_status_idx" ON "public"."PurchaseOrder"("organizationId", "status");

-- CreateIndex
CREATE INDEX "PurchaseOrder_salesOrderId_idx" ON "public"."PurchaseOrder"("salesOrderId");

-- CreateIndex
CREATE INDEX "PurchaseOrder_supplierId_idx" ON "public"."PurchaseOrder"("supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_organizationId_poNumber_key" ON "public"."PurchaseOrder"("organizationId", "poNumber");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_organizationId_idempotencyKey_key" ON "public"."PurchaseOrder"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "PurchaseOrderLine_organizationId_purchaseOrderId_idx" ON "public"."PurchaseOrderLine"("organizationId", "purchaseOrderId");

-- CreateIndex
CREATE INDEX "PurchaseOrderLine_salesOrderLineId_idx" ON "public"."PurchaseOrderLine"("salesOrderLineId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrderLine_purchaseOrderId_lineNo_key" ON "public"."PurchaseOrderLine"("purchaseOrderId", "lineNo");

-- CreateIndex
CREATE INDEX "SupplierAcknowledgement_organizationId_reviewStatus_idx" ON "public"."SupplierAcknowledgement"("organizationId", "reviewStatus");

-- CreateIndex
CREATE INDEX "SupplierAcknowledgement_purchaseOrderId_createdAt_idx" ON "public"."SupplierAcknowledgement"("purchaseOrderId", "createdAt");

-- CreateIndex
CREATE INDEX "GoodsReceipt_organizationId_purchaseOrderId_idx" ON "public"."GoodsReceipt"("organizationId", "purchaseOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceipt_organizationId_receiptNumber_key" ON "public"."GoodsReceipt"("organizationId", "receiptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceipt_organizationId_idempotencyKey_key" ON "public"."GoodsReceipt"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "GoodsReceiptLine_organizationId_goodsReceiptId_idx" ON "public"."GoodsReceiptLine"("organizationId", "goodsReceiptId");

-- CreateIndex
CREATE INDEX "GoodsReceiptLine_purchaseOrderLineId_idx" ON "public"."GoodsReceiptLine"("purchaseOrderLineId");

-- CreateIndex
CREATE INDEX "Delivery_organizationId_salesOrderId_idx" ON "public"."Delivery"("organizationId", "salesOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Delivery_organizationId_deliveryNumber_key" ON "public"."Delivery"("organizationId", "deliveryNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Delivery_organizationId_idempotencyKey_key" ON "public"."Delivery"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "DeliveryLine_organizationId_deliveryId_idx" ON "public"."DeliveryLine"("organizationId", "deliveryId");

-- CreateIndex
CREATE INDEX "DeliveryLine_salesOrderLineId_idx" ON "public"."DeliveryLine"("salesOrderLineId");

-- CreateIndex
CREATE INDEX "CustomerInvoice_organizationId_status_idx" ON "public"."CustomerInvoice"("organizationId", "status");

-- CreateIndex
CREATE INDEX "CustomerInvoice_salesOrderId_idx" ON "public"."CustomerInvoice"("salesOrderId");

-- CreateIndex
CREATE INDEX "CustomerInvoice_customerId_idx" ON "public"."CustomerInvoice"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerInvoice_organizationId_invoiceNumber_key" ON "public"."CustomerInvoice"("organizationId", "invoiceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerInvoice_organizationId_idempotencyKey_key" ON "public"."CustomerInvoice"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "CustomerInvoiceLine_organizationId_invoiceId_idx" ON "public"."CustomerInvoiceLine"("organizationId", "invoiceId");

-- CreateIndex
CREATE INDEX "CustomerPayment_organizationId_status_idx" ON "public"."CustomerPayment"("organizationId", "status");

-- CreateIndex
CREATE INDEX "CustomerPayment_customerId_idx" ON "public"."CustomerPayment"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerPayment_organizationId_paymentNumber_key" ON "public"."CustomerPayment"("organizationId", "paymentNumber");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerPayment_organizationId_idempotencyKey_key" ON "public"."CustomerPayment"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "PaymentAllocation_organizationId_invoiceId_idx" ON "public"."PaymentAllocation"("organizationId", "invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAllocation_paymentId_invoiceId_key" ON "public"."PaymentAllocation"("paymentId", "invoiceId");

-- CreateIndex
CREATE INDEX "SupplierBill_organizationId_status_idx" ON "public"."SupplierBill"("organizationId", "status");

-- CreateIndex
CREATE INDEX "SupplierBill_supplierId_idx" ON "public"."SupplierBill"("supplierId");

-- CreateIndex
CREATE INDEX "SupplierBill_purchaseOrderId_idx" ON "public"."SupplierBill"("purchaseOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierBill_organizationId_billNumber_key" ON "public"."SupplierBill"("organizationId", "billNumber");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierBill_organizationId_idempotencyKey_key" ON "public"."SupplierBill"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "SupplierPayment_organizationId_supplierBillId_idx" ON "public"."SupplierPayment"("organizationId", "supplierBillId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierPayment_organizationId_paymentNumber_key" ON "public"."SupplierPayment"("organizationId", "paymentNumber");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierPayment_organizationId_idempotencyKey_key" ON "public"."SupplierPayment"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "OrderStatusEvent_organizationId_entityType_entityId_idx" ON "public"."OrderStatusEvent"("organizationId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "OrderStatusEvent_organizationId_createdAt_idx" ON "public"."OrderStatusEvent"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "OrderDiscrepancy_organizationId_status_idx" ON "public"."OrderDiscrepancy"("organizationId", "status");

-- CreateIndex
CREATE INDEX "OrderDiscrepancy_entityType_entityId_idx" ON "public"."OrderDiscrepancy"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "OrderDiscrepancy_salesOrderId_idx" ON "public"."OrderDiscrepancy"("salesOrderId");

-- CreateIndex

-- CreateIndex

-- CreateIndex

-- CreateIndex

-- CreateIndex

-- CreateIndex

-- CreateIndex

-- CreateIndex

-- CreateIndex

-- CreateIndex

-- CreateIndex

-- CreateIndex

-- CreateIndex

-- CreateIndex

-- CreateIndex

-- CreateIndex

-- AddForeignKey
ALTER TABLE "public"."SalesOrder" ADD CONSTRAINT "SalesOrder_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SalesOrder" ADD CONSTRAINT "SalesOrder_enquiryId_fkey" FOREIGN KEY ("enquiryId") REFERENCES "public"."Enquiry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SalesOrder" ADD CONSTRAINT "SalesOrder_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "public"."CustomerQuotation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SalesOrder" ADD CONSTRAINT "SalesOrder_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "public"."Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SalesOrderLine" ADD CONSTRAINT "SalesOrderLine_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SalesOrderLine" ADD CONSTRAINT "SalesOrderLine_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "public"."SalesOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SalesOrderLine" ADD CONSTRAINT "SalesOrderLine_enquiryItemId_fkey" FOREIGN KEY ("enquiryItemId") REFERENCES "public"."EnquiryItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "public"."SalesOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "public"."Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "public"."PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_salesOrderLineId_fkey" FOREIGN KEY ("salesOrderLineId") REFERENCES "public"."SalesOrderLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_supplierOfferId_fkey" FOREIGN KEY ("supplierOfferId") REFERENCES "public"."SupplierOffer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SupplierAcknowledgement" ADD CONSTRAINT "SupplierAcknowledgement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SupplierAcknowledgement" ADD CONSTRAINT "SupplierAcknowledgement_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "public"."PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "public"."PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_goodsReceiptId_fkey" FOREIGN KEY ("goodsReceiptId") REFERENCES "public"."GoodsReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_purchaseOrderLineId_fkey" FOREIGN KEY ("purchaseOrderLineId") REFERENCES "public"."PurchaseOrderLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Delivery" ADD CONSTRAINT "Delivery_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Delivery" ADD CONSTRAINT "Delivery_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "public"."SalesOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DeliveryLine" ADD CONSTRAINT "DeliveryLine_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DeliveryLine" ADD CONSTRAINT "DeliveryLine_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "public"."Delivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DeliveryLine" ADD CONSTRAINT "DeliveryLine_salesOrderLineId_fkey" FOREIGN KEY ("salesOrderLineId") REFERENCES "public"."SalesOrderLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CustomerInvoice" ADD CONSTRAINT "CustomerInvoice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CustomerInvoice" ADD CONSTRAINT "CustomerInvoice_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "public"."SalesOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CustomerInvoice" ADD CONSTRAINT "CustomerInvoice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "public"."Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CustomerInvoiceLine" ADD CONSTRAINT "CustomerInvoiceLine_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CustomerInvoiceLine" ADD CONSTRAINT "CustomerInvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "public"."CustomerInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CustomerInvoiceLine" ADD CONSTRAINT "CustomerInvoiceLine_salesOrderLineId_fkey" FOREIGN KEY ("salesOrderLineId") REFERENCES "public"."SalesOrderLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CustomerPayment" ADD CONSTRAINT "CustomerPayment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CustomerPayment" ADD CONSTRAINT "CustomerPayment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "public"."Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "public"."CustomerPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "public"."CustomerInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SupplierBill" ADD CONSTRAINT "SupplierBill_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SupplierBill" ADD CONSTRAINT "SupplierBill_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "public"."Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SupplierBill" ADD CONSTRAINT "SupplierBill_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "public"."PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SupplierPayment" ADD CONSTRAINT "SupplierPayment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SupplierPayment" ADD CONSTRAINT "SupplierPayment_supplierBillId_fkey" FOREIGN KEY ("supplierBillId") REFERENCES "public"."SupplierBill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OrderStatusEvent" ADD CONSTRAINT "OrderStatusEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OrderStatusEvent" ADD CONSTRAINT "OrderStatusEvent_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "public"."SalesOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OrderDiscrepancy" ADD CONSTRAINT "OrderDiscrepancy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OrderDiscrepancy" ADD CONSTRAINT "OrderDiscrepancy_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "public"."SalesOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "public"."SupplierEmailReply_organizationId_provider_externalMessageId_ke" RENAME TO "SupplierEmailReply_organizationId_provider_externalMessageI_key";

