import { NextResponse, type NextRequest } from "next/server";

const AUTH_COOKIE_NAMES = [
  "better-auth.session_token",
  "__Secure-better-auth.session_token",
] as const;

const PROTECTED_ROUTE_PREFIXES = [
  "/jobs",
  "/saved",
  "/applications",
  "/dashboard",
  "/notifications",
  "/documents/compare",
  "/profile",
  "/settings",
  "/ops",
] as const;

function hasSessionCookie(request: NextRequest) {
  return AUTH_COOKIE_NAMES.some((name) => Boolean(request.cookies.get(name)?.value));
}

function isProtectedRoute(pathname: string) {
  return PROTECTED_ROUTE_PREFIXES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`)
  );
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const isAuthenticated = hasSessionCookie(request);

  if (!isAuthenticated && isProtectedRoute(pathname)) {
    const signInUrl = new URL("/", request.url);
    signInUrl.searchParams.set("callbackUrl", `${pathname}${search}`);
    return NextResponse.redirect(signInUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/jobs/:path*",
    "/saved/:path*",
    "/applications/:path*",
    "/dashboard/:path*",
    "/notifications/:path*",
    "/documents/compare/:path*",
    "/profile/:path*",
    "/settings/:path*",
    "/ops/:path*",
  ],
};
