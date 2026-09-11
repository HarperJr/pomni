import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  type BacklogItem,
  type BoardMoves,
  type FlowState,
  type PipelineRun,
  type TransitionOffer,
} from './api';
import { RunningBadge, errorMessage } from './components';
import { describeUnmet } from './items';
import { useLanguage } from './i18n';

/**
 * A project's backlog as a board.
 *
 * The board is a *view of the flow*, never a second definition of it. Every question it asks —
 * may this move, what is missing, what happens next — is answered by the flow, through the
 * same call the CLI makes. A project configured once behaves the same in the browser and in
 * the terminal, which is the only way the two can be trusted to agree.
 *
 * Columns come from the project's own states, in the flow's own order, so a project that adds
 * a state gets a column and nobody edits this file.
 */
export function Board({
  projectId,
  items,
  running,
  waves,
  waitingOn,
}: {
  projectId: string;
  items: BacklogItem[];
  running: PipelineRun[];
  /** Which concurrency wave each item falls in, from POMN-25. Empty when it could not be read. */
  waves: Map<string, number>;
  /** Items this one is waiting on, when it is waiting on something.  */
  waitingOn: Map<string, string[]>;
}) {
  const queryClient = useQueryClient();
  const { t } = useLanguage();
  const [held, setHeld] = useState<string | null>(null);
  const [refused, setRefused] = useState<{ itemId: string; reason: string } | null>(null);

  const flow = useQuery({
    queryKey: ['item-flow', projectId],
    queryFn: () => api.getItemFlow(projectId),
    staleTime: 60_000,
  });

  // One request for the whole board. Each card needs to know which columns will take it, what
  // is outstanding for the next one, and why a drop was refused — and all three come off the
  // same answer, so asking per card would be one request per card for one fact three times.
  const board = useQuery({
    queryKey: ['board-moves', projectId],
    queryFn: () => api.boardMoves(projectId),
  });

  const move = useMutation({
    mutationFn: (input: { itemId: string; to: string }) =>
      api.transitionItem(projectId, input.itemId, { to: input.to }),
    onSuccess: async () => {
      setRefused(null);
      await queryClient.invalidateQueries({ queryKey: ['items', projectId] });
      await queryClient.invalidateQueries({ queryKey: ['board-moves', projectId] });
    },
    // The flow refuses in one place and says why once. Showing that sentence rather than a
    // generic failure is the difference between a board you can learn from and one that
    // silently springs a card back to where it was.
    onError: (error: unknown, input) =>
      setRefused({ itemId: input.itemId, reason: errorMessage(error) }),
  });

  const movesById = new Map((board.data ?? []).map((entry) => [entry.itemId, entry]));
  const columns = boardColumns(flow.data?.states ?? [], items, (state) =>
    t('board.offFlow', { state }),
  );

  return (
    <div className="board">
      {columns.map((column) => {
        const cards = items.filter((item) => item.status === column.name);
        const takes = held ? accepts(movesById.get(held), column.name) : null;

        return (
          <div
            key={column.name}
            className={`board-column${takes === false ? ' board-column-shut' : ''}${
              takes === true ? ' board-column-open' : ''
            }`}
            onDragOver={(event) => {
              // Only a column that would actually accept this card is a drop target. A column
              // that takes the drop and then springs the card back teaches nothing.
              if (takes) event.preventDefault();
            }}
            onDrop={() => {
              if (held && takes) move.mutate({ itemId: held, to: column.name });
              setHeld(null);
            }}
          >
            <div className="board-column-head">
              <span className="grow truncate">{column.label}</span>
              <span className="dim mono">{cards.length}</span>
            </div>

            {cards.map((item) => (
              <Card
                key={item.id}
                item={item}
                moves={movesById.get(item.id)}
                runs={running.filter((run) => run.itemId === item.id)}
                refusal={refused?.itemId === item.id ? refused.reason : null}
                wave={waves.get(item.id)}
                waitingOn={waitingOn.get(item.id)}
                held={held === item.id}
                onHold={setHeld}
                onMove={(to) => move.mutate({ itemId: item.id, to })}
                busy={move.isPending}
              />
            ))}

            {cards.length === 0 && <div className="board-empty">—</div>}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The columns to draw, in the flow's own order.
 *
 * A state marked off the board is not drawn — a flow may have states that are bookkeeping
 * rather than places work sits. The exception is a state some item is actually standing in:
 * hiding a column that has cards in it hides the cards, and a card nobody can see is a card
 * nobody moves.
 *
 * With no flow configured the states are the built-in ones, because that is what `flowOf`
 * hands back — so the board works before anybody configures anything.
 */
function boardColumns(
  states: FlowState[],
  items: BacklogItem[],
  offFlow: (state: string) => string,
): FlowState[] {
  const occupied = new Set(items.map((item) => item.status));
  const columns = states.filter((state) => state.board || occupied.has(state.name));

  // An item whose status is not a state at all still has to appear somewhere. It gets its own
  // column rather than being dropped, because an item standing off the flow is precisely the
  // one somebody opened the board to rescue.
  const known = new Set(states.map((state) => state.name));
  const strays = [...occupied].filter((status) => !known.has(status)).sort();

  return [
    ...columns,
    ...strays.map((name) => ({ name, label: offFlow(name), board: true, active: true })),
  ];
}

/** Whether this card may enter that column: true, false, or unknown while the board loads. */
function accepts(moves: BoardMoves | undefined, column: string): boolean | null {
  if (!moves) return null;
  return moves.transitions.some((offer) => offer.to === column && offer.ok);
}

function Card({
  item,
  moves,
  runs,
  refusal,
  wave,
  waitingOn,
  held,
  onHold,
  onMove,
  busy,
}: {
  item: BacklogItem;
  moves: BoardMoves | undefined;
  runs: PipelineRun[];
  refusal: string | null;
  wave: number | undefined;
  waitingOn: string[] | undefined;
  held: boolean;
  onHold: (itemId: string | null) => void;
  onMove: (to: string) => void;
  busy: boolean;
}) {
  const [menu, setMenu] = useState(false);
  const { t } = useLanguage();
  const [itemRun] = runs;
  const offers = moves?.transitions ?? [];

  return (
    <div
      className={`board-card${held ? ' board-card-held' : ''}`}
      draggable
      onDragStart={() => onHold(item.id)}
      onDragEnd={() => onHold(null)}
    >
      <Link
        to={itemRun ? `/p/${item.projectId}/console/${itemRun.id}` : `/p/${item.projectId}/items/${item.id}`}
      >
        <strong>{item.title}</strong>
      </Link>

      <div className="board-card-meta">
        <span className="dim mono">{item.id}</span>
        <span className="tag">{item.priority}</span>
        <span className="tag">{item.type}</span>
        {wave !== undefined && <span className="tag">{t('board.wave', { n: wave })}</span>}
        {waitingOn && (
          <span className="tag warn" title={t('board.waitingOn', { items: waitingOn.join(', ') })}>
            {t('board.waiting')}
          </span>
        )}
        <RunningBadge runs={runs} />
      </div>

      <Outstanding offers={offers} />

      {refusal && <div className="hint transition-reason">{refusal}</div>}

      {/* Dragging is not available to everyone, and is awkward on a phone. The menu is the
          same transition call, not a second path with its own rules. */}
      <div className="board-card-moves">
        <button className="ghost" onClick={() => setMenu((was) => !was)} type="button">
          {t('board.move')}
        </button>
        {menu && (
          <div className="board-menu">
            {offers.length === 0 && <div className="dim">{t('board.nowhere')}</div>}
            {offers.map((offer) => (
              <button
                key={offer.to}
                className="ghost"
                disabled={!offer.ok || busy}
                title={offer.ok ? undefined : offer.unmet.map(describeUnmet).join('; ')}
                onClick={() => {
                  setMenu(false);
                  onMove(offer.to);
                }}
                type="button"
              >
                {offer.label}
                {offer.ok ? '' : ` — ${t('board.blocked')}`}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * What stands between this card and the next column, at a glance.
 *
 * The nearest blocked move rather than all of them: a card with four arrows out of it has
 * four lists of requirements, and a card that says everything says nothing. A card with a
 * move it could make right now says that instead, because that is the more useful fact.
 */
function Outstanding({ offers }: { offers: TransitionOffer[] }) {
  const { t } = useLanguage();

  const ready = offers.find((offer) => offer.ok);
  if (ready) {
    return <div className="hint board-ready">{t('board.readyFor', { state: ready.label })}</div>;
  }

  const blocked = offers.find((offer) => offer.unmet.length > 0);
  if (!blocked) return null;

  return (
    <div className="hint board-outstanding" title={blocked.unmet.map(describeUnmet).join('; ')}>
      {blocked.label}: {blocked.unmet.map(describeUnmet).join('; ')}
    </div>
  );
}
