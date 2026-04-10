import { redirect } from "next/navigation";

export default function SavedPage() {
  redirect("/applications?status=WISHLIST");
}
