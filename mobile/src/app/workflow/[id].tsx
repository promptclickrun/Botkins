import { useLocalSearchParams } from "expo-router";
import { WorkflowDesigner } from "@/features/workflows/Designer";

/** A workflow's designer and runs, as a full page so the canvas can fill a tablet or a phone on its side. `new` makes one first. */
export default function WorkflowScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <WorkflowDesigner id={id} />;
}
