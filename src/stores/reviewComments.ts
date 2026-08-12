import { create } from "zustand";

export interface ReviewLineComment {
  id: string;
  taskId: string;
  /** Exact semantic owner and evidence the draft was authored against. */
  terminalId: string;
  generation: number;
  fingerprint: string;
  path: string;
  /** One-based source line. */
  line: number;
  body: string;
  createdAt: number;
}

interface ReviewCommentsState {
  comments: ReviewLineComment[];
  add: (comment: Omit<ReviewLineComment, "id" | "createdAt">) => void;
  remove: (id: string) => void;
  clearTask: (taskId: string) => void;
}

/** Deliberately session-only: drafts can contain sensitive review context. */
export const useReviewCommentsStore = create<ReviewCommentsState>((set) => ({
  comments: [],
  add: (comment) =>
    set((state) => ({
      comments: [
        ...state.comments,
        { ...comment, id: crypto.randomUUID(), createdAt: Date.now() },
      ],
    })),
  remove: (id) => set((state) => ({ comments: state.comments.filter((item) => item.id !== id) })),
  clearTask: (taskId) => set((state) => ({ comments: state.comments.filter((item) => item.taskId !== taskId) })),
}));
