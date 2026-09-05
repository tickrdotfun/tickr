import { Suspense } from "react";
import { CreateForm } from "@/components/create/CreateForm";

export default function CreatePage() {
  return (
    <div>
      <h1 className="cascade-1 mb-12">Create a launch</h1>
      <div className="cascade-data">
        <Suspense fallback={null}>
          <CreateForm />
        </Suspense>
      </div>
    </div>
  );
}
