// Project subpage: Jobs (uses the existing Jobs component, running jobs first).
import { router, useLocalSearchParams } from "expo-router";
import { Rocket } from "lucide-react-native";
import { useCapability, useChats, useMember, usePart } from "@/state/hooks";
import { useApp } from "@/state/store";
import { EmptyState, Loading, Page } from "@/ui";
import { Jobs } from "./Jobs";
import { jobCounts, projectJobs } from "./jobLogic";

export default function ProjectJobsPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const project = useApp((state) => state.parts.projects?.find((item) => item.id === id));
  const synced = useApp((state) => state.synced);
  const jobsOn = useCapability("project-jobs-v1");
  const member = useMember();
  const chats = useChats();
  const live = usePart("live");

  if (!project) {
    return (
      <Page>
        {synced ? <EmptyState title="This project is gone" action="Go back" onAction={() => router.back()} /> : <Loading />}
      </Page>
    );
  }

  if (!jobsOn || member) {
    return (
      <Page title="Jobs">
        <EmptyState
          icon={Rocket}
          title="Jobs are not available here"
          text="Project jobs are available to the owner on a computer with Jobs enabled."
          action="Go back"
          onAction={() => router.back()}
        />
      </Page>
    );
  }

  const jobs = projectJobs(chats, project.id);
  const summary = jobCounts(live, jobs);
  const caption =
    summary || (jobs.length === 0 ? "None yet" : jobs.length === 1 ? "1 job" : `${jobs.length} jobs`);

  return (
    <Page title="Jobs" caption={caption} keyboard>
      <Jobs project={project} standalone />
    </Page>
  );
}
