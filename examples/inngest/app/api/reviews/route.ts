/**
 * Next.js route handler: enqueue a review and return immediately.
 *
 * POST /api/reviews  { paperId }  →  202 { reviewId }
 * GET  /api/reviews?id=...        →  { status, progress, message, result? }
 */
import { NextRequest, NextResponse } from "next/server";
import { inngest } from "../../../functions/review-paper.js";

// import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
  const { paperId } = await req.json();
  if (!paperId) {
    return NextResponse.json({ error: "paperId required" }, { status: 400 });
  }

  // 1. Create the tracking row first so the client can poll right away
  // const review = await prisma.aiReview.create({
  //   data: { paperId, status: "pending", progress: 0 },
  // });
  const review = { id: "replace-with-db-row-id" };

  // 2. Fire the event — the Inngest function does the long work
  await inngest.send({
    name: "paper/review.requested",
    data: { paperId, reviewId: review.id },
  });

  return NextResponse.json({ reviewId: review.id }, { status: 202 });
}

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  // const review = await prisma.aiReview.findUnique({ where: { id } });
  // if (!review) return NextResponse.json({ error: "not found" }, { status: 404 });
  // return NextResponse.json({
  //   status: review.status,
  //   progress: review.progress,
  //   message: review.message,
  //   // Only include the (large) result when finished:
  //   result: review.status === "completed" ? review.resultJson : undefined,
  // });
  return NextResponse.json({ status: "pending", progress: 0 });
}
