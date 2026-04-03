-- CreateIndex
CREATE INDEX "ApplicationPackage_userId_canonicalJobId_idx" ON "ApplicationPackage"("userId", "canonicalJobId");

-- CreateIndex
CREATE INDEX "ApplicationSubmission_userId_canonicalJobId_idx" ON "ApplicationSubmission"("userId", "canonicalJobId");

-- CreateIndex
CREATE INDEX "ResumeVariant_userId_idx" ON "ResumeVariant"("userId");
