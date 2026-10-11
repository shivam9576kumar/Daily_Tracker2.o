-- CreateTable
CREATE TABLE "practice_topics" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "practice_topics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "practice_problems" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "topic_id" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "practice_problems_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "practice_topics_source_order_idx" ON "practice_topics"("source", "order");

-- CreateIndex
CREATE UNIQUE INDEX "practice_topics_source_slug_key" ON "practice_topics"("source", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "practice_problems_url_key" ON "practice_problems"("url");

-- CreateIndex
CREATE INDEX "practice_problems_topic_id_order_idx" ON "practice_problems"("topic_id", "order");

-- CreateIndex
CREATE INDEX "practice_problems_source_is_active_idx" ON "practice_problems"("source", "is_active");

-- AddForeignKey
ALTER TABLE "practice_problems" ADD CONSTRAINT "practice_problems_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "practice_topics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
