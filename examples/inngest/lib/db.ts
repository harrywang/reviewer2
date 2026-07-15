/**
 * Persistence stubs — replace with your ORM (Prisma, Drizzle, ...).
 *
 * A minimal schema that works well:
 *
 *   model AiReview {
 *     id         String   @id @default(cuid())
 *     paperId    String
 *     status     String   // pending | running | completed | failed
 *     progress   Int      @default(0)   // 0-100
 *     message    String?
 *     resultJson Json?    // the viz-compatible PaperReviewJson
 *     createdAt  DateTime @default(now())
 *     updatedAt  DateTime @updatedAt
 *   }
 */
import type { PaperReviewJson } from "reviewer2";

export async function loadPaperText(
  paperId: string,
): Promise<{ text: string; title: string; slug: string }> {
  // e.g. fetch the extracted markdown from your DB or S3
  throw new Error(`implement loadPaperText(${paperId})`);
}

export async function updateReviewProgress(
  reviewId: string,
  progress: { done: number; total: number; commentsSoFar: number },
): Promise<void> {
  // e.g. prisma.aiReview.update({ where: { id: reviewId }, data: {
  //   status: "running",
  //   progress: Math.round((progress.done / progress.total) * 90),
  //   message: `Reviewed ${progress.done}/${progress.total} passages (${progress.commentsSoFar} comments)`,
  // }})
}

export async function saveReviewResult(
  reviewId: string,
  paper: PaperReviewJson,
): Promise<void> {
  // e.g. prisma.aiReview.update({ where: { id: reviewId }, data: {
  //   status: "completed", progress: 100, resultJson: paper,
  // }})
}
