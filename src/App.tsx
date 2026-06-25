import { useState } from "react";
import LibraryPage from "./pages/LibraryPage";
import PracticeRoom from "./pages/PracticeRoom";
import ExercisePage from "./pages/ExercisePage";

type Route = { page: "library" } | { page: "practice"; songId: string } | { page: "exercise" };

function App() {
  const [route, setRoute] = useState<Route>({ page: "library" });

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
    </div>
  );
}

export default App;
