-- DropIndex
DROP INDEX "practice_problems_url_key";

-- CreateIndex
CREATE UNIQUE INDEX "practice_problems_source_id_key" ON "practice_problems"("source", "id");
