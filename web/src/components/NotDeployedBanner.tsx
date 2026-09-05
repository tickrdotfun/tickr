import { DEPLOYED } from "@/lib/addresses";

export function NotDeployedBanner() {
  if (DEPLOYED) return null;
  return (
    <div className="max-w-6xl mx-auto px-6 sm:px-8 pt-6 text-[14px] text-muted">
      <span className="label mr-2">Not deployed</span>
      The factory address is zero. Add <span className="num text-white">contracts/deployments/4663.json</span> or set{" "}
      <span className="num text-white">NEXT_PUBLIC_FACTORY</span> (and friends) in <span className="num text-white">.env.local</span>, then restart.
    </div>
  );
}
