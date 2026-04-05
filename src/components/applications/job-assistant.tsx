"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Textarea } from "@/components/ui/textarea";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

type JobAssistantProps = {
  applicationId: string;
  company: string;
  roleTitle: string;
  aiConfigured: boolean;
  hasJobDescription: boolean;
  hasResume: boolean;
  hasCoverLetter: boolean;
  hasFitAnalysis: boolean;
  hasNotes: boolean;
};

const starterQuestions = [
  "What should I emphasize most for this role?",
  "What interview questions should I prepare for?",
  "What are the biggest risks in my application?",
  "Draft a short recruiter follow-up for this job.",
] as const;

type RenderTone = "assistant" | "user";

function renderInlineBold(text: string, tone: RenderTone = "assistant"): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const regex = /\*\*(.+?)\*\*/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    parts.push(
      <strong className={toneTextClass(tone, "font-semibold")} key={match.index}>
        {match[1]}
      </strong>
    );
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}

function isShortHeading(line: string) {
  return /^[A-Z][A-Za-z0-9\s/&()-]{1,48}:$/.test(line.trim());
}

function toneTextClass(tone: RenderTone, base: string) {
  return tone === "user" ? `${base} text-background` : `${base} text-foreground`;
}

function renderFormattedText(text: string, tone: RenderTone = "assistant") {
  const lines = text.split("\n");
  const blocks: Array<
    | { type: "heading"; text: string }
    | { type: "paragraph"; text: string }
    | { type: "bullet-list"; items: string[] }
    | { type: "number-list"; items: string[] }
  > = [];

  let index = 0;
  while (index < lines.length) {
    const rawLine = lines[index] ?? "";
    const line = rawLine.trim();

    if (!line) {
      index += 1;
      continue;
    }

    const boldHeadingMatch = line.match(/^\*\*(.+)\*\*$/);
    if (boldHeadingMatch) {
      blocks.push({ type: "heading", text: boldHeadingMatch[1] });
      index += 1;
      continue;
    }

    if (isShortHeading(line)) {
      blocks.push({ type: "heading", text: line.slice(0, -1) });
      index += 1;
      continue;
    }

    if (/^(?:•|-|\*|·)\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const candidate = (lines[index] ?? "").trim();
        if (!candidate) {
          index += 1;
          break;
        }
        if (!/^(?:•|-|\*|·)\s+/.test(candidate)) {
          break;
        }
        items.push(candidate.replace(/^(?:•|-|\*|·)\s+/, ""));
        index += 1;
      }
      blocks.push({ type: "bullet-list", items });
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const candidate = (lines[index] ?? "").trim();
        if (!candidate) {
          index += 1;
          break;
        }
        if (!/^\d+\.\s+/.test(candidate)) {
          break;
        }
        items.push(candidate.replace(/^\d+\.\s+/, ""));
        index += 1;
      }
      blocks.push({ type: "number-list", items });
      continue;
    }

    const paragraphLines: string[] = [line];
    index += 1;
    while (index < lines.length) {
      const candidate = (lines[index] ?? "").trim();
      if (!candidate) {
        index += 1;
        break;
      }
      if (
        /^\*\*(.+)\*\*$/.test(candidate) ||
        isShortHeading(candidate) ||
        /^(?:•|-|\*|·)\s+/.test(candidate) ||
        /^\d+\.\s+/.test(candidate)
      ) {
        break;
      }
      paragraphLines.push(candidate);
      index += 1;
    }
    blocks.push({ type: "paragraph", text: paragraphLines.join(" ") });
  }

  const headingClass =
    tone === "user"
      ? "mt-3 text-sm font-semibold text-background first:mt-0"
      : "mt-3 text-sm font-semibold text-foreground first:mt-0";
  const paragraphClass =
    tone === "user"
      ? "text-sm leading-6 text-background"
      : "text-sm leading-6 text-foreground/80";
  const listTextClass = tone === "user" ? "text-background" : "text-foreground/80";
  const listMarkerClass = tone === "user" ? "text-background/70" : "text-muted-foreground";

  return blocks.map((block, blockIndex) => {
    if (block.type === "heading") {
      return (
        <p className={headingClass} key={blockIndex}>
          {block.text}
        </p>
      );
    }

    if (block.type === "paragraph") {
      return (
        <p className={paragraphClass} key={blockIndex}>
          {renderInlineBold(block.text, tone)}
        </p>
      );
    }

    if (block.type === "bullet-list") {
      return (
        <ul className="mt-1 space-y-1.5" key={blockIndex}>
          {block.items.map((item, itemIndex) => (
            <li
              className={`grid grid-cols-[auto_1fr] gap-2 text-sm leading-6 ${listTextClass}`}
              key={itemIndex}
            >
              <span className={`mt-[0.15rem] ${listMarkerClass}`}>•</span>
              <span>{renderInlineBold(item, tone)}</span>
            </li>
          ))}
        </ul>
      );
    }

    return (
      <ol className="mt-1 space-y-1.5" key={blockIndex}>
        {block.items.map((item, itemIndex) => (
          <li
            className={`grid grid-cols-[auto_1fr] gap-2 text-sm leading-6 ${listTextClass}`}
            key={itemIndex}
          >
            <span className={`mt-[0.05rem] font-medium ${listMarkerClass}`}>{itemIndex + 1}.</span>
            <span>{renderInlineBold(item, tone)}</span>
          </li>
        ))}
      </ol>
    );
  });
}

function ContextBadge({ label, active }: { label: string; active: boolean }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium ${
        active
          ? "border-border/80 bg-foreground/[0.05] text-foreground shadow-sm dark:bg-foreground/[0.08]"
          : "border-border/60 bg-background/70 text-muted-foreground"
      }`}
    >
      {label}
    </span>
  );
}

export function JobAssistant({
  applicationId,
  company,
  roleTitle,
  aiConfigured,
  hasJobDescription,
  hasResume,
  hasCoverLetter,
  hasFitAnalysis,
  hasNotes,
}: JobAssistantProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function askQuestion(nextQuestion: string) {
    const trimmed = nextQuestion.trim();
    if (!trimmed || pending || !aiConfigured) {
      return;
    }

    const history = messages.slice(-8).map((message) => ({
      role: message.role,
      content: message.content,
    }));

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: trimmed,
    };

    setMessages((prev) => [...prev, userMessage]);
    setQuestion("");
    setError(null);
    setPending(true);

    try {
      const response = await fetch(`/api/applications/${applicationId}/assistant`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          question: trimmed,
          history,
        }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(typeof payload.error === "string" ? payload.error : "Assistant request failed.");
        return;
      }

      const answer = typeof payload.answer === "string" ? payload.answer.trim() : "";
      if (!answer) {
        setError("AI returned an empty response. Please try again.");
        return;
      }

      setMessages((prev) => [
        ...prev,
        {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content: answer,
        },
      ]);
    } catch {
      setError("Network error. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="surface-panel relative overflow-hidden border-border/80 bg-[radial-gradient(circle_at_top_right,rgba(15,23,42,0.07),transparent_26%),radial-gradient(circle_at_bottom_left,rgba(15,23,42,0.05),transparent_30%),linear-gradient(180deg,rgba(255,255,255,0.98),rgba(248,250,252,0.94))] p-0 shadow-[0_20px_50px_rgba(15,23,42,0.10)] dark:bg-[radial-gradient(circle_at_top_right,rgba(148,163,184,0.10),transparent_28%),radial-gradient(circle_at_bottom_left,rgba(148,163,184,0.07),transparent_32%),linear-gradient(180deg,rgba(10,16,24,0.96),rgba(9,14,22,0.92))] dark:shadow-[0_24px_64px_rgba(2,6,23,0.42)]">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.14] [background-image:linear-gradient(to_right,rgba(148,163,184,0.16)_1px,transparent_1px),linear-gradient(to_bottom,rgba(148,163,184,0.16)_1px,transparent_1px)] [background-size:24px_24px] [mask-image:linear-gradient(to_bottom,rgba(255,255,255,0.85),transparent)] dark:opacity-[0.08]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-16 top-0 h-40 w-40 rounded-full bg-foreground/[0.08] blur-3xl dark:bg-foreground/[0.08]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-14 left-0 h-32 w-32 rounded-full bg-foreground/[0.06] blur-3xl dark:bg-foreground/[0.06]"
      />

      <div className="relative">
      <div className="border-b border-border/70 bg-background/48 px-5 py-4 backdrop-blur-md dark:bg-background/12">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-foreground/60">
              Job-Scoped Assistant
            </p>
            <h3 className="mt-1 text-base font-semibold text-foreground">Ask AI about this job</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Uses the current role, saved notes, linked documents, fit analysis, and your profile.
            </p>
          </div>
          {messages.length > 0 ? (
            <Button
              className="h-8 px-3 text-xs"
              onClick={() => {
                setMessages([]);
                setError(null);
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              Clear
            </Button>
          ) : null}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <ContextBadge active={hasJobDescription} label="Job description" />
          <ContextBadge active={hasResume} label="Resume" />
          <ContextBadge active={hasCoverLetter} label="Cover letter" />
          <ContextBadge active={hasFitAnalysis} label="Fit analysis" />
          <ContextBadge active={hasNotes} label="Notes" />
        </div>
      </div>

      <div className="bg-background/18 px-5 py-4 dark:bg-background/0">
        {!aiConfigured ? (
          <p className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            OpenAI is not configured. Add <code>OPENAI_API_KEY</code> to use the job assistant.
          </p>
        ) : null}

        {messages.length === 0 ? (
          <div className="space-y-4">
            <div className="rounded-2xl border border-border/70 bg-background/78 px-4 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.32)] backdrop-blur-sm dark:bg-background/38 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
              <p className="text-sm text-foreground/80">
                Ask about <span className="font-medium text-foreground">{roleTitle}</span> at{" "}
                <span className="font-medium text-foreground">{company}</span>.
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Good for interview prep, resume decisions, recruiter messages, and next-step planning.
              </p>
            </div>

            <div className="grid gap-2">
              {starterQuestions.map((prompt) => (
                <button
                  className="rounded-xl border border-border/70 bg-background/92 px-3 py-2 text-left text-sm text-foreground/80 shadow-sm transition hover:bg-foreground/[0.04] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 dark:bg-background/55"
                  disabled={!aiConfigured || pending}
                  key={prompt}
                  onClick={() => {
                    void askQuestion(prompt);
                  }}
                  type="button"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="min-h-[28rem] max-h-[44rem] space-y-3 overflow-y-auto rounded-2xl border border-border/70 bg-background/82 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.26)] backdrop-blur-sm dark:bg-background/34 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
            {messages.map((message) => (
              <div
                className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
                key={message.id}
              >
                <div
                  className={`max-w-[88%] rounded-2xl px-3.5 py-3 ${
                    message.role === "user"
                      ? "bg-foreground text-background shadow-[0_10px_24px_rgba(15,23,42,0.18)]"
                      : "border border-border/70 bg-background/92 text-foreground shadow-sm dark:bg-background/65"
                  }`}
                >
                  <p
                    className={`mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] ${
                      message.role === "user" ? "text-background/70" : "text-foreground/55"
                    }`}
                  >
                    {message.role === "user" ? "You" : "AI"}
                  </p>
                  {renderFormattedText(
                    message.content,
                    message.role === "user" ? "user" : "assistant"
                  )}
                </div>
              </div>
            ))}

            {pending ? (
              <div className="flex justify-start">
                <div className="flex items-center gap-2 rounded-2xl border border-border/70 bg-background/92 px-3.5 py-3 shadow-sm dark:bg-background/60">
                  <LoadingSpinner className="h-3.5 w-3.5" />
                  <span className="text-sm text-muted-foreground">Thinking...</span>
                </div>
              </div>
            ) : null}
          </div>
        )}

        {error ? (
          <p className="mt-3 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}

        <form
          className="mt-4 grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void askQuestion(question);
          }}
        >
          <div className="rounded-2xl border border-border/70 bg-background/88 p-2 shadow-[0_14px_30px_rgba(15,23,42,0.08),inset_0_1px_0_rgba(255,255,255,0.3)] backdrop-blur-sm dark:bg-background/40 dark:shadow-[0_16px_34px_rgba(2,6,23,0.16),inset_0_1px_0_rgba(255,255,255,0.05)]">
            <Textarea
              className="min-h-[92px] resize-y border-0 bg-transparent px-1 py-1 text-sm shadow-none focus-visible:ring-0"
              disabled={!aiConfigured || pending}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="Ask about this role, your fit, interview prep, or what to do next..."
              rows={3}
              value={question}
            />
            <div className="mt-2 flex items-center justify-between gap-3 border-t border-border/70 pt-2">
              <p className="text-xs text-muted-foreground">
                Best after adding the job description and linking your resume.
              </p>
              <Button
                className="h-8 bg-foreground px-3 text-xs text-background shadow-[0_10px_24px_rgba(15,23,42,0.18)] hover:opacity-95"
                disabled={!aiConfigured || pending || !question.trim()}
                size="sm"
                type="submit"
              >
                {pending ? (
                  <>
                    <LoadingSpinner className="h-3 w-3" />
                    Asking...
                  </>
                ) : (
                  "Ask AI"
                )}
              </Button>
            </div>
          </div>
        </form>
      </div>
      </div>
    </div>
  );
}
