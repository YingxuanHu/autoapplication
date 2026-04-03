-- CreateIndex
CREATE INDEX "JobCanonical_status_postedAt_idx" ON "JobCanonical"("status", "postedAt" DESC);

-- CreateIndex
CREATE INDEX "JobCanonical_status_region_postedAt_idx" ON "JobCanonical"("status", "region", "postedAt" DESC);

-- CreateIndex
CREATE INDEX "JobCanonical_status_roleFamily_postedAt_idx" ON "JobCanonical"("status", "roleFamily", "postedAt" DESC);

-- CreateIndex
CREATE INDEX "JobCanonical_status_workMode_postedAt_idx" ON "JobCanonical"("status", "workMode", "postedAt" DESC);

-- CreateIndex
CREATE INDEX "JobCanonical_status_experienceLevel_postedAt_idx" ON "JobCanonical"("status", "experienceLevel", "postedAt" DESC);

-- CreateIndex
CREATE INDEX "JobCanonical_status_industry_postedAt_idx" ON "JobCanonical"("status", "industry", "postedAt" DESC);

-- CreateIndex
CREATE INDEX "JobCanonical_status_salaryMax_idx" ON "JobCanonical"("status", "salaryMax" DESC);

-- CreateIndex
CREATE INDEX "JobEligibility_submissionCategory_idx" ON "JobEligibility"("submissionCategory");

-- CreateIndex
CREATE INDEX "SavedJob_userId_status_idx" ON "SavedJob"("userId", "status");

-- CreateIndex
CREATE INDEX "UserBehaviorSignal_userId_action_idx" ON "UserBehaviorSignal"("userId", "action");

-- CreateIndex
CREATE INDEX "UserBehaviorSignal_userId_canonicalJobId_action_idx" ON "UserBehaviorSignal"("userId", "canonicalJobId", "action");
