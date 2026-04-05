import { redirect } from "next/navigation";

type DashboardSearchParams = Record<string, string | string[] | undefined>;

export default async function DashboardRedirectPage({
  searchParams,
}: {
  searchParams: Promise<DashboardSearchParams>;
}) {
  const params = await searchParams;
  const nextParams = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry) {
          nextParams.append(key, entry);
        }
      }
      continue;
    }

    if (value) {
      nextParams.set(key, value);
    }
  }

  const query = nextParams.toString();
  redirect(query ? `/applications?${query}` : "/applications");
}
