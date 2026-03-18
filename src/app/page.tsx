import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import {
  Layers,
  FileText,
  BarChart3,
  Lightbulb,
  Briefcase,
  ArrowRight,
} from "lucide-react";

const features = [
  {
    icon: Layers,
    title: "Smart Job Feed",
    description:
      "Discover relevant opportunities from multiple sources, filtered and ranked by your preferences and qualifications.",
  },
  {
    icon: FileText,
    title: "Resume Management",
    description:
      "Maintain multiple tailored resumes. Auto-match the best version to each job posting for maximum impact.",
  },
  {
    icon: BarChart3,
    title: "Application Tracking",
    description:
      "Track every application from submission to response. Never lose sight of where you stand with each opportunity.",
  },
  {
    icon: Lightbulb,
    title: "Learning Recommendations",
    description:
      "Get personalized suggestions for skills and certifications that will strengthen your candidacy.",
  },
];

export default function LandingPage() {
  return (
    <div className="flex flex-col min-h-full">
      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-border bg-background/80 backdrop-blur-sm">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 md:px-8">
          <div className="flex items-center gap-2.5">
            <Briefcase className="size-6 text-primary" />
            <span className="text-lg font-semibold tracking-tight">
              AutoApplication
            </span>
          </div>
          <div className="flex items-center gap-3">
            <Link href="/login" className={buttonVariants({ variant: "ghost", size: "sm" })}>
              Sign In
            </Link>
            <Link href="/register" className={buttonVariants({ size: "sm" })}>
              Get Started
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="flex-1 flex flex-col items-center justify-center px-4 py-20 md:py-32">
        <div className="mx-auto max-w-3xl text-center">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-muted/50 px-4 py-1.5 text-sm text-muted-foreground">
            <Briefcase className="size-3.5" />
            Job search, supercharged
          </div>
          <h1 className="text-4xl font-bold tracking-tight text-foreground sm:text-5xl md:text-6xl">
            Apply to Jobs at Scale,{" "}
            <span className="text-primary">Without Losing Control</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground md:text-xl">
            Search, discover, and apply to jobs at scale with precision and
            control. AutoApplication streamlines your job search so you can
            focus on what matters -- landing the right role.
          </p>
          <div className="mt-10 flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
            <Link href="/register" className={buttonVariants({ size: "lg" }) + " gap-2"}>
              Get Started
              <ArrowRight className="size-4" />
            </Link>
            <Link href="/login" className={buttonVariants({ variant: "outline", size: "lg" })}>
              Sign In
            </Link>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="border-t border-border bg-muted/30 px-4 py-20 md:py-28">
        <div className="mx-auto max-w-6xl">
          <div className="text-center">
            <h2 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
              Everything you need for a smarter job search
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-muted-foreground">
              AutoApplication brings together the tools you need to find, apply,
              and track opportunities -- all in one place.
            </p>
          </div>

          <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {features.map((feature) => {
              const Icon = feature.icon;
              return (
                <Card key={feature.title} className="relative overflow-hidden">
                  <CardHeader>
                    <div className="mb-3 inline-flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Icon className="size-5" />
                    </div>
                    <CardTitle className="text-base">{feature.title}</CardTitle>
                    <CardDescription>{feature.description}</CardDescription>
                  </CardHeader>
                </Card>
              );
            })}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border bg-background px-4 py-8">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 sm:flex-row">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Briefcase className="size-4" />
            AutoApplication
          </div>
          <p className="text-sm text-muted-foreground">
            Built to help you land the right role, faster.
          </p>
        </div>
      </footer>
    </div>
  );
}
