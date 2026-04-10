import type { ReactNode } from "react";

type AuthShellProps = {
  contextTitle: string;
  contextDescription: string;
  highlights: string[];
  footer?: ReactNode;
  children: ReactNode;
};

export function AuthShell({
  contextTitle,
  contextDescription,
  highlights,
  footer,
  children,
}: AuthShellProps) {
  return (
    <main className="app-page flex min-h-screen items-center">
      <div className="mx-auto grid w-full max-w-6xl gap-10 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-center">
        <section className="hidden lg:block">
          <p className="section-label">North America job engine</p>
          <h1 className="mt-3 max-w-xl text-4xl font-semibold tracking-tight text-foreground">
            {contextTitle}
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-muted-foreground">
            {contextDescription}
          </p>
          <div className="mt-8 grid max-w-xl gap-3">
            {highlights.map((item) => (
              <div
                key={item}
                className="surface-panel-muted px-4 py-3 text-sm leading-6 text-muted-foreground"
              >
                {item}
              </div>
            ))}
          </div>
          {footer ? <div className="mt-6 text-sm text-muted-foreground">{footer}</div> : null}
        </section>

        <div className="mx-auto w-full max-w-md">{children}</div>
      </div>
    </main>
  );
}
