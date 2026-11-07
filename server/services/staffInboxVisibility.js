'use strict';

// Match the staff inbox: archive state belongs to the assigned staff member or
// to their participant row. An owner's participant row cannot undo their archive.
function staffInboxPredicate(staff = '$2', archived = 'FALSE') {
  return `(
    (${archived}::boolean AND (
      (mt.staff_user_id = ${staff} AND (mt.staff_archived_at IS NOT NULL OR mt.status = 'archived'))
      OR (mt.staff_user_id != ${staff} AND tp.id IS NOT NULL AND tp.archived_at IS NOT NULL)
    )) OR (NOT ${archived}::boolean AND mt.status != 'archived' AND (
      (mt.staff_user_id = ${staff} AND mt.staff_archived_at IS NULL)
      OR (mt.staff_user_id != ${staff} AND tp.id IS NOT NULL AND tp.archived_at IS NULL)
    ))
  )`;
}
module.exports = { staffInboxPredicate };
