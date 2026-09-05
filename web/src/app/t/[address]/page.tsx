import { isAddress, getAddress } from "viem";
import { TokenPage } from "@/components/token/TokenPage";

export default async function Page(props: PageProps<"/t/[address]">) {
  const { address } = await props.params;
  if (!isAddress(address)) {
    return <div className="text-muted">Not a valid address: {address}</div>;
  }
  return <TokenPage address={getAddress(address)} />;
}
