import { createFileRoute } from "@tanstack/react-router";
import { Console } from "@/components/berth/console";

export const Route = createFileRoute("/")({
  component: Home,
  head: () => ({
    meta: [
      { title: "Berth" },
      {
        name: "description",
        content: "Site docks on this host. Chrome stays here. You send the task.",
      },
    ],
  }),
});

function Home() {
  return <Console />;
}
