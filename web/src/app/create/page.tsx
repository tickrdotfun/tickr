import { Suspense } from "react";
import { CreateForm } from "@/components/create/CreateForm";
import { Panel } from "@/components/ui";
import { OFFICIAL_V2, ZERO } from "@/lib/addresses";
import { CHAIN_ID } from "@/lib/chain";
import { DEMO } from "@/lib/demoTransport";

/**
 * Launching on the public chain waits for the v2 genesis: the first coin on v2 is the official one. The page opens
 * by itself once the deployment record carries `genesisV2Token`, which the site deploy made straight after that
 * launch picks up, so nobody has to remember to flip anything. Only the public chain waits; the preview, a local
 * devnet and the Sepolia rehearsal keep their create page. This closes the site's door, not the contracts':
 * `Factory.setLaunchEnabled` is the owner's switch for that.
 */
const WAITING_FOR_V2_GENESIS = CHAIN_ID === 4663 && !DEMO && OFFICIAL_V2.token === ZERO;

export default function CreatePage() {
  return (
    <div>
      <h1 className="cascade-1 mb-12">Create a launch</h1>
      <div className="cascade-data">
        {WAITING_FOR_V2_GENESIS ? (
          <Panel title="launching opens with the v2 genesis coin">
            <p className="text-muted max-w-2xl">
              the create page opens again right after it launches. every coin already live keeps trading as usual.
            </p>
          </Panel>
        ) : (
          <Suspense fallback={null}>
            <CreateForm />
          </Suspense>
        )}
      </div>
    </div>
  );
}
