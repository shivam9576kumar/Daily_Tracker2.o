-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "practice_problem_id" TEXT,
ADD COLUMN     "practice_run" INTEGER;

-- CreateTable
CREATE TABLE "cses_tracks" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "enabled_at" TIMESTAMP(3),
    "active_topic_id" TEXT,
    "prompt_ack_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cses_tracks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cses_topic_runs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "topic_id" TEXT NOT NULL,
    "current_run" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cses_topic_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cses_tracks_user_id_key" ON "cses_tracks"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "cses_topic_runs_user_id_topic_id_key" ON "cses_topic_runs"("user_id", "topic_id");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_user_id_practice_problem_id_practice_run_key" ON "tasks"("user_id", "practice_problem_id", "practice_run");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_practice_problem_id_fkey" FOREIGN KEY ("practice_problem_id") REFERENCES "practice_problems"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cses_tracks" ADD CONSTRAINT "cses_tracks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cses_tracks" ADD CONSTRAINT "cses_tracks_active_topic_id_fkey" FOREIGN KEY ("active_topic_id") REFERENCES "practice_topics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cses_topic_runs" ADD CONSTRAINT "cses_topic_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cses_topic_runs" ADD CONSTRAINT "cses_topic_runs_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "practice_topics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
