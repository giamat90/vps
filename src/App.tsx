import { useEffect, useState } from "react";
import LibraryPage from "./pages/LibraryPage";
import PracticeRoom from "./pages/PracticeRoom";
import ExercisePage from "./pages/ExercisePage";
import UpdateDialog from "./components/updater/UpdateDialog";
import { useUpdaterStore } from "./stores/updater";

type Route = { page: "library" } | { page: "practice"; songId: string } | { page: "exercise" };

function App() {
  const [route, setRoute] = useState<Route>({ page: "library" });
  const checkForUpdates = useUpdaterStore((s) => s.checkForUpdates);

  useEffect(() => {
    checkForUpdates();
  }, [checkForUpdates]);

  return (
    <div className="app">
      {route.page === "library" ? (
        <LibraryPage
          onSelectSong={(songId) => setRoute({ page: "practice", songId })}
          onGoToExercise={() => setRoute({ page: "exercise" })}
        />
      ) : route.page === "exercise" ? (
        <ExercisePage onBack={() => setRoute({ page: "library" })} />
      ) : (
        <PracticeRoom
          songId={route.songId}
          onBack={() => setRoute({ page: "library" })}
        />
      )}
      <UpdateDialog />
    </div>
  );
}

export default App;
