import { Button } from "../../components/primitives/Button.jsx";
import { Modal } from "../../components/Modal.jsx";

export function TaskDetailModals({
  statusModal,
  setStatusModal,
  applyStatusTransition,
  deleteOpen,
  setDeleteOpen,
  destroy,
  commentDeleteTarget,
  commentDeleting,
  setCommentDeleteTarget,
  deleteComment,
}) {
  return (
    <>
      <Modal
        open={!!statusModal}
        onClose={() => setStatusModal(null)}
        title="Confirm stage change"
        size="sm"
        footer={(
          <>
            <Button variant="ghost" onClick={() => setStatusModal(null)}>Cancel</Button>
            <Button variant="primary" onClick={() => {
              const t = statusModal;
              setStatusModal(null);
              applyStatusTransition(t);
            }}>Confirm</Button>
          </>
        )}
      >
        <p>{statusModal?.confirm || ""}</p>
      </Modal>

      <Modal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Delete task?"
        size="sm"
        footer={(
          <>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => { setDeleteOpen(false); destroy(); }}>Delete</Button>
          </>
        )}
      >
        <p>This permanently removes the task and its runs. This action cannot be undone.</p>
      </Modal>

      <Modal
        open={!!commentDeleteTarget}
        onClose={() => !commentDeleting && setCommentDeleteTarget(null)}
        title="Delete comment?"
        size="sm"
        footer={(
          <>
            <Button variant="ghost" disabled={commentDeleting} onClick={() => setCommentDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" loading={commentDeleting} onClick={deleteComment}>Delete</Button>
          </>
        )}
      >
        <p>This permanently removes this human comment from the task and future run prompts.</p>
      </Modal>
    </>
  );
}
