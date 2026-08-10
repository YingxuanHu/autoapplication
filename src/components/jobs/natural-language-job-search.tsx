"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Loader2, Mic, MicOff, Search, Sparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { showJobsLoadingPopup } from "@/components/jobs/jobs-navigation-pending-boundary";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { mergeNaturalLanguageJobsSearch } from "@/lib/jobs/search-state";
import type { NaturalLanguageJobSearchResult } from "@/lib/jobs/natural-language-search";

const DESCRIPTION_PLACEHOLDER = "Describe a role, location, level, or work style";
const MAX_DESCRIPTION_LENGTH = 600;

type SpeechRecognitionAlternativeLike = {
  transcript: string;
};

type SpeechRecognitionResultLike = {
  isFinal: boolean;
  [index: number]: SpeechRecognitionAlternativeLike | undefined;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: SpeechRecognitionResultLike | undefined;
  };
};

type SpeechRecognitionErrorEventLike = {
  error?: string;
};

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onend: (() => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onstart: (() => void) | null;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function getSpeechRecognitionConstructor() {
  if (typeof window === "undefined") return null;
  const speechWindow = window as Window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;
}

function joinTranscriptParts(...parts: Array<string | null | undefined>) {
  return parts
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .slice(0, MAX_DESCRIPTION_LENGTH);
}

function getSpeechErrorMessage(error?: string) {
  if (error === "not-allowed" || error === "service-not-allowed") {
    return "Microphone access was blocked. Allow microphone access or type what you want.";
  }
  if (error === "no-speech") {
    return "No speech was detected. Try again or type what you want.";
  }
  if (error === "audio-capture") {
    return "No microphone was found. Type what you want instead.";
  }
  return "Voice input stopped. You can keep typing or try again.";
}

export function NaturalLanguageJobSearch() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [voiceMessage, setVoiceMessage] = useState<string | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [speechSupported, setSpeechSupported] = useState<boolean | null>(null);
  const [isPending, setIsPending] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const baseTranscriptRef = useRef("");
  const finalTranscriptRef = useRef("");
  const interimTranscriptRef = useRef("");

  useEffect(() => {
    setSpeechSupported(Boolean(getSpeechRecognitionConstructor()));
    return () => {
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    };
  }, []);

  function stopListening() {
    recognitionRef.current?.stop();
  }

  function startListening() {
    const SpeechRecognition = getSpeechRecognitionConstructor();
    if (!SpeechRecognition) {
      setSpeechSupported(false);
      setVoiceMessage("Voice input is not available in this browser. Type what you want instead.");
      return;
    }

    recognitionRef.current?.abort();
    baseTranscriptRef.current = text.trim();
    finalTranscriptRef.current = "";
    interimTranscriptRef.current = "";
    setVoiceMessage(null);
    setError(null);

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";
    recognition.onstart = () => setIsListening(true);
    recognition.onerror = (event) => {
      setVoiceMessage(getSpeechErrorMessage(event.error));
    };
    recognition.onresult = (event) => {
      const finalParts: string[] = [];
      const interimParts: string[] = [];

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const resultEntry = event.results[index];
        if (!resultEntry) continue;
        const transcript = resultEntry?.[0]?.transcript?.trim();
        if (!transcript) continue;
        if (resultEntry.isFinal) finalParts.push(transcript);
        else interimParts.push(transcript);
      }

      if (finalParts.length > 0) {
        finalTranscriptRef.current = joinTranscriptParts(
          finalTranscriptRef.current,
          finalParts.join(" ")
        );
      }
      interimTranscriptRef.current = interimParts.join(" ").trim();
      setText(
        joinTranscriptParts(
          baseTranscriptRef.current,
          finalTranscriptRef.current,
          interimTranscriptRef.current
        )
      );
    };
    recognition.onend = () => {
      setText(
        joinTranscriptParts(
          baseTranscriptRef.current,
          finalTranscriptRef.current,
          interimTranscriptRef.current
        )
      );
      interimTranscriptRef.current = "";
      recognitionRef.current = null;
      setIsListening(false);
    };

    recognitionRef.current = recognition;
    recognition.start();
  }

  function toggleListening() {
    if (isListening) {
      stopListening();
      return;
    }
    startListening();
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) {
      setError("Type or speak the jobs you want.");
      return;
    }

    if (isListening) stopListening();
    setIsPending(true);
    setError(null);
    try {
      const response = await fetch("/api/jobs/natural-language-search", {
        body: JSON.stringify({ text: trimmed }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as
        | NaturalLanguageJobSearchResult
        | { error?: string }
        | null;

      if (!response.ok) {
        setError(payload && "error" in payload && payload.error ? payload.error : "Could not interpret this search.");
        return;
      }

      const searchResult = payload as NaturalLanguageJobSearchResult;
      const href = mergeNaturalLanguageJobsSearch(searchParams, searchResult.params);
      showJobsLoadingPopup(href);
      router.push(href);
    } catch {
      setError("Could not interpret this search.");
    } finally {
      setIsPending(false);
    }
  }

  return (
    <section className="space-y-2">
      <form className="flex flex-col gap-2 sm:flex-row sm:items-center" onSubmit={handleSubmit}>
        <label className="flex min-w-0 flex-1 items-center rounded-[14px] border border-border bg-card transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
          <Sparkles className="ml-3.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <Input
            aria-label="Describe the jobs you want"
            className="h-11 border-0 bg-transparent px-3 text-sm shadow-none focus-visible:ring-0"
            maxLength={MAX_DESCRIPTION_LENGTH}
            onChange={(event) => {
              if (isListening) stopListening();
              setText(event.target.value);
              setError(null);
            }}
            placeholder={DESCRIPTION_PLACEHOLDER}
            value={text}
          />
          <div className="mr-1.5 flex shrink-0 items-center gap-0.5">
            {text ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      aria-label="Clear description"
                      onClick={() => {
                        if (isListening) stopListening();
                        setText("");
                        setError(null);
                        setVoiceMessage(null);
                      }}
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  }
                />
                <TooltipContent>Clear description</TooltipContent>
              </Tooltip>
            ) : null}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={isListening ? "Stop voice input" : "Start voice input"}
                    aria-pressed={isListening}
                    className={
                      isListening
                        ? "bg-destructive text-destructive-foreground hover:bg-destructive/90 hover:text-destructive-foreground"
                        : ""
                    }
                    disabled={isPending || speechSupported === false}
                    onClick={toggleListening}
                    size="icon-sm"
                    type="button"
                    variant={isListening ? "destructive" : "ghost"}
                  >
                    {isListening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                  </Button>
                }
              />
              <TooltipContent>{isListening ? "Stop voice input" : "Use voice input"}</TooltipContent>
            </Tooltip>
          </div>
        </label>
        <div className="flex sm:shrink-0">
          <Button className="w-full sm:w-auto" disabled={isPending} type="submit">
            {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            Find jobs
          </Button>
        </div>
      </form>

      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : null}
      {voiceMessage ? (
        <p className="text-xs text-destructive">{voiceMessage}</p>
      ) : null}
    </section>
  );
}
