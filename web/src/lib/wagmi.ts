import { createConfig } from "wagmi";
import { injected } from "wagmi/connectors";
import { robinhoodChain } from "./chain";
import { DEMO, demoTransport } from "./demoTransport";
import { siteTransport } from "./transport";

export const wagmiConfig = createConfig({
  chains: [robinhoodChain],
  connectors: [injected()],
  transports: {
    // Demo builds replay a recorded fork instead of reaching a chain; see demoTransport.ts.
    [robinhoodChain.id]: DEMO ? demoTransport() : siteTransport(),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
