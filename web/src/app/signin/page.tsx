import type { Metadata } from "next";
import { SignInScreen } from "@/components/auth/SignInScreen";

export const metadata: Metadata = {
  title: "OrbitCall · Sign in",
  description: "Sign in to see your fleet and coordinate close approaches.",
};

export default function SignInPage() {
  return <SignInScreen />;
}
