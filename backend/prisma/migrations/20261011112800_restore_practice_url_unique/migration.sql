-- DropIndex
DROP INDEX "practice_problems_source_id_key";

-- CreateIndex
CREATE UNIQUE INDEX "practice_problems_url_key" ON "practice_problems"("url");
