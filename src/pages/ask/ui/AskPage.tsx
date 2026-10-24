import type { ComponentProps } from "react";
import { LibraryQuestion } from "../../../widgets/library-question";

export type AskPageProps = ComponentProps<typeof LibraryQuestion> & {
  /** Back to the meetings page; Escape does the same. */
  onBack: () => void;
};

/** Ask across meetings: a full page with the 48px header and no meetings sidebar. */
export function AskPage({ onBack, ...question }: AskPageProps) {
  return (
    <div className="page">
      <header className="page-head">
        <button
          type="button"
          className="ghost back"
          aria-label="Back to meetings"
          onClick={onBack}
        >
          <span className="arrow" aria-hidden="true">
            ←
          </span>
          Meetings
        </button>
        <kbd className="page-esc" aria-hidden="true">
          Esc
        </kbd>
        <span className="sep" aria-hidden="true" />
        <h1>Ask</h1>
      </header>
      <main className="page-body">
        <div className="ask-column">
          <LibraryQuestion {...question} />
        </div>
      </main>
    </div>
  );
}
