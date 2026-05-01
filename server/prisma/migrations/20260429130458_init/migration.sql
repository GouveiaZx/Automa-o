-- CreateTable
CREATE TABLE "AdminUser" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "windowStart" TEXT NOT NULL,
    "windowEnd" TEXT NOT NULL,
    "minIntervalMin" INTEGER NOT NULL DEFAULT 60,
    "maxIntervalMin" INTEGER NOT NULL DEFAULT 180,
    "storiesPerDay" INTEGER NOT NULL DEFAULT 3,
    "reelsPerDay" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AdsPowerProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "adsPowerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "lastOpenedAt" DATETIME
);

-- CreateTable
CREATE TABLE "InstagramAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "displayName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastFailureAt" DATETIME,
    "consecutiveFails" INTEGER NOT NULL DEFAULT 0,
    "campaignId" TEXT,
    "adsPowerProfileId" TEXT,
    CONSTRAINT "InstagramAccount_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "InstagramAccount_adsPowerProfileId_fkey" FOREIGN KEY ("adsPowerProfileId") REFERENCES "AdsPowerProfile" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MediaItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "caption" TEXT,
    "thumbnail" TEXT,
    "campaignId" TEXT NOT NULL,
    "publishedAt" DATETIME,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MediaItem_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PostJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "scheduledFor" DATETIME NOT NULL,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PostJob_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "InstagramAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PostJob_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "MediaItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AutomationLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "level" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "accountId" TEXT,
    "jobId" TEXT,
    "message" TEXT NOT NULL,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_email_key" ON "AdminUser"("email");

-- CreateIndex
CREATE UNIQUE INDEX "AdsPowerProfile_adsPowerId_key" ON "AdsPowerProfile"("adsPowerId");

-- CreateIndex
CREATE UNIQUE INDEX "InstagramAccount_username_key" ON "InstagramAccount"("username");

-- CreateIndex
CREATE UNIQUE INDEX "InstagramAccount_adsPowerProfileId_key" ON "InstagramAccount"("adsPowerProfileId");

-- CreateIndex
CREATE INDEX "PostJob_status_scheduledFor_idx" ON "PostJob"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "PostJob_accountId_status_idx" ON "PostJob"("accountId", "status");

-- CreateIndex
CREATE INDEX "AutomationLog_createdAt_idx" ON "AutomationLog"("createdAt");
