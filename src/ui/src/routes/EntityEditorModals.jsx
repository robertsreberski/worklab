import { Modal } from "../components/Modal.jsx";
import { Button } from "../components/primitives/Button.jsx";

export function EntityEditorModals({
  deleteOpen,
  setDeleteOpen,
  deleteTitle,
  deleteMessage,
  onDelete,
  guard,
  saving = false,
}) {
  return (
    <>
      <Modal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title={deleteTitle}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => { setDeleteOpen(false); onDelete?.(); }}>Delete</Button>
          </>
        }
      >
        <p>{deleteMessage}</p>
      </Modal>

      <Modal
        open={guard.promptOpen}
        onClose={guard.keepEditing}
        title="You have unsaved changes"
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={guard.keepEditing}>Keep editing</Button>
            <Button variant="destructive" onClick={guard.discardAndLeave}>Discard</Button>
            <Button variant="primary" loading={saving} onClick={() => guard.saveAndLeave().catch(() => {})}>
              Save & leave
            </Button>
          </>
        }
      >
        <p>Your changes have not been saved.</p>
      </Modal>
    </>
  );
}
