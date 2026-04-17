const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

// ─── CONFIG ────────────────────────────────────────────────────────────────
const MONDAY_API_KEY   = process.env.MONDAY_API_KEY;  // set in Render environment variables
const STATUS_COLUMN_ID = "status";                    // column ID of Status on the parent board
// ───────────────────────────────────────────────────────────────────────────

// ─── RULES (checked in order) ──────────────────────────────────────────────
//
// Rule 6 (all subitems done) is always checked first.
// Rules 1–5 only fire when the changed subitem's status becomes "Done".
//
//  name rules:   if the subitem NAME includes the text → set parent to that status
//  status rules: if the subitem STATUS includes the text → set parent to that status

const NAME_RULES = [
  { includes: "Approve Script",       setParentTo: "Production"       },
  { includes: "Post Production",      setParentTo: "Post Production"  },
  { includes: "Feedback",             setParentTo: "Feedback Open"    },
  { includes: "Approve for Creative", setParentTo: "Pending Approval" },
  { includes: "Approve for Content",  setParentTo: "Pending Approval" },
  { includes: "House #",              setParentTo: "Send/Upload Media" },
];
// ───────────────────────────────────────────────────────────────────────────

app.post("/webhook", async (req, res) => {
  const body = req.body;

  // Monday sends a challenge when you first register the webhook — echo it back
  if (body.challenge) return res.json({ challenge: body.challenge });

  const event = body.event;
  if (!event) return res.sendStatus(200);

  const { pulseId, value } = event;
  const newStatusLabel = value?.label?.text?.trim() || "";

  try {
    // ── 1. Fetch the changed subitem + all sibling subitems ─────────────────
    const subitemData = await mondayQuery(`
      query {
        items(ids: [${pulseId}]) {
          name
          parent_item {
            id
            subitems {
              id
              column_values(ids: ["${STATUS_COLUMN_ID}"]) {
                text
              }
            }
          }
        }
      }
    `);

    const subitem    = subitemData?.data?.items?.[0];
    if (!subitem) return res.sendStatus(200);

    const subitemName = subitem.name?.trim() || "";
    const parentId    = subitem.parent_item?.id;
    const subitems    = subitem.parent_item?.subitems || [];

    if (!parentId) {
      console.log("No parent item — skipping.");
      return res.sendStatus(200);
    }

    // ── 2. Get the parent item's board ID ───────────────────────────────────
    const parentData = await mondayQuery(`
      query {
        items(ids: [${parentId}]) {
          board { id }
        }
      }
    `);

    const boardId = parentData?.data?.items?.[0]?.board?.id;
    if (!boardId) {
      console.error("Could not find board for parent item", parentId);
      return res.sendStatus(200);
    }

    // ── 3. Load the status column's label → index map ───────────────────────
    const boardData = await mondayQuery(`
      query {
        boards(ids: [${boardId}]) {
          columns(ids: ["${STATUS_COLUMN_ID}"]) {
            settings_str
          }
        }
      }
    `);

    const settingsStr = boardData?.data?.boards?.[0]?.columns?.[0]?.settings_str;
    const labels      = JSON.parse(settingsStr || "{}").labels || {};

    // Helper: updates the parent item's status column
    async function setParentStatus(targetStatus) {
      const entry = Object.entries(labels).find(
        ([, label]) => label.toLowerCase() === targetStatus.toLowerCase()
      );

      if (!entry) {
        console.error(`⚠️  Status label "${targetStatus}" not found on board.`);
        console.error("Available labels:", Object.values(labels).join(", "));
        return;
      }

      const [statusIndex] = entry;

      await mondayQuery(`
        mutation {
          change_column_value(
            board_id: ${boardId},
            item_id: ${parentId},
            column_id: "${STATUS_COLUMN_ID}",
            value: "{\\"index\\": ${statusIndex}}"
          ) { id }
        }
      `);

      console.log(`✅ Parent item ${parentId} → "${targetStatus}"`);
    }

    // ── RULE 6: All subitems are Done or Approved → set parent to Done ──────
    //    This is checked first and takes priority over all other rules.
    if (subitems.length > 0) {
      const allComplete = subitems.every((si) => {
        const statusText = si.column_values?.[0]?.text?.toLowerCase() || "";
        return statusText === "done" || statusText === "approved";
      });

      if (allComplete) {
        await setParentStatus("Done");
        return res.sendStatus(200);
      }
    }

    // ── RULES 1–5: Name-based rules (only when this subitem is marked Done) ─
    if (newStatusLabel.toLowerCase() !== "done") {
      console.log(`Subitem status changed to "${newStatusLabel}" — no name rules apply.`);
      return res.sendStatus(200);
    }

    for (const rule of NAME_RULES) {
      if (subitemName.includes(rule.includes)) {
        console.log(`Matched rule: "${rule.includes}" → "${rule.setParentTo}"`);
        await setParentStatus(rule.setParentTo);
        return res.sendStatus(200);
      }
    }

    console.log(`No rule matched for subitem "${subitemName}".`);
    return res.sendStatus(200);

  } catch (err) {
    console.error("Error handling webhook:", err);
    return res.sendStatus(500);
  }
});

// Helper: sends a GraphQL query to Monday's API
async function mondayQuery(query) {
  const response = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": MONDAY_API_KEY,
    },
    body: JSON.stringify({ query }),
  });
  return response.json();
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook server running on port ${PORT}`));
