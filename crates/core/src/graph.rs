use git2::{Oid, Repository, Sort};
use serde::Serialize;

use crate::{Result, lossy};

/// A lane (column) of the graph where it crosses the edge of a row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct LaneRef {
    pub lane: u32,
    pub color: u32,
}

/// Where a commit sits in the graph and which lines cross its row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct RowLayout {
    pub lane: u32,
    pub color: u32,
    /// Lanes coming from the row above that end at this commit.
    pub incoming: Vec<LaneRef>,
    /// Lanes leaving this commit towards its parents in the rows below.
    pub outgoing: Vec<LaneRef>,
    /// Lanes that cross the row without touching this commit.
    pub passing: Vec<LaneRef>,
}

#[derive(Debug, Clone, Copy)]
struct Lane<T> {
    awaiting: T,
    color: u32,
}

/// Assigns lanes to commits fed in topological order (children before parents).
#[derive(Debug)]
pub(crate) struct LaneLayout<T> {
    lanes: Vec<Option<Lane<T>>>,
    next_color: u32,
}

impl<T: Copy + PartialEq> LaneLayout<T> {
    pub(crate) fn new() -> Self {
        Self {
            lanes: Vec::new(),
            next_color: 0,
        }
    }

    pub(crate) fn place(&mut self, id: T, parents: &[T]) -> RowLayout {
        let mut incoming = Vec::new();
        let mut passing = Vec::new();
        for (index, slot) in self.lanes.iter_mut().enumerate() {
            let Some(lane) = *slot else { continue };
            let lane_ref = LaneRef {
                lane: index as u32,
                color: lane.color,
            };
            if lane.awaiting == id {
                incoming.push(lane_ref);
                *slot = None;
            } else {
                passing.push(lane_ref);
            }
        }

        // Every lane that was waiting for this commit converges on the leftmost one.
        let node = incoming.first().copied().unwrap_or_else(|| LaneRef {
            lane: self.first_free() as u32,
            color: self.new_color(),
        });

        let mut outgoing = Vec::new();
        for (n, &parent) in parents.iter().enumerate() {
            let target = if n == 0 {
                // The first parent continues straight down, which keeps a branch
                // in its own lane until the commit it forked from.
                self.occupy(node.lane as usize, parent, node.color)
            } else if let Some(existing) = self.lane_awaiting(parent) {
                existing
            } else {
                let lane = self.first_free();
                let color = self.new_color();
                self.occupy(lane, parent, color)
            };
            outgoing.push(target);
        }

        while matches!(self.lanes.last(), Some(None)) {
            self.lanes.pop();
        }

        RowLayout {
            lane: node.lane,
            color: node.color,
            incoming,
            outgoing,
            passing,
        }
    }

    fn occupy(&mut self, lane: usize, awaiting: T, color: u32) -> LaneRef {
        if lane == self.lanes.len() {
            self.lanes.push(None);
        }
        self.lanes[lane] = Some(Lane { awaiting, color });
        LaneRef {
            lane: lane as u32,
            color,
        }
    }

    fn lane_awaiting(&self, id: T) -> Option<LaneRef> {
        self.lanes.iter().enumerate().find_map(|(index, slot)| {
            let lane = slot.as_ref().filter(|lane| lane.awaiting == id)?;
            Some(LaneRef {
                lane: index as u32,
                color: lane.color,
            })
        })
    }

    fn first_free(&self) -> usize {
        self.lanes
            .iter()
            .position(Option::is_none)
            .unwrap_or(self.lanes.len())
    }

    fn new_color(&mut self) -> u32 {
        let color = self.next_color;
        self.next_color += 1;
        color
    }
}

/// One row of the commit graph, ready to be drawn.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct GraphRow {
    pub id: String,
    pub summary: String,
    pub author_name: String,
    pub author_email: String,
    /// Author time, in seconds since the Unix epoch.
    pub time: i64,
    pub layout: RowLayout,
}

/// The history reachable from every branch and tag, laid out on demand.
pub(crate) struct Graph {
    order: Vec<Oid>,
    layout: LaneLayout<Oid>,
    rows: Vec<RowLayout>,
}

impl Graph {
    pub(crate) fn walk(repo: &Repository) -> Result<Self> {
        let mut revwalk = repo.revwalk()?;
        revwalk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)?;
        for glob in ["refs/heads/*", "refs/remotes/*", "refs/tags/*"] {
            revwalk.push_glob(glob)?;
        }
        // A detached HEAD may not be reachable from any ref; an unborn one has no commit.
        if repo.head().is_ok() {
            revwalk.push_head()?;
        }
        let order = revwalk.collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(Self {
            order,
            layout: LaneLayout::new(),
            rows: Vec::new(),
        })
    }

    pub(crate) fn len(&self) -> usize {
        self.order.len()
    }

    pub(crate) fn index_of(&self, id: Oid) -> Option<usize> {
        self.order.iter().position(|&commit| commit == id)
    }

    /// Every commit of the graph, newest first.
    pub(crate) fn ids(&self) -> &[Oid] {
        &self.order
    }

    pub(crate) fn rows(
        &mut self,
        repo: &Repository,
        offset: usize,
        limit: usize,
    ) -> Result<Vec<GraphRow>> {
        let end = offset.saturating_add(limit).min(self.order.len());

        // A row's lanes depend on every row above it, so the layout only grows from the top.
        while self.rows.len() < end {
            let id = self.order[self.rows.len()];
            let parents: Vec<Oid> = repo.find_commit(id)?.parent_ids().collect();
            self.rows.push(self.layout.place(id, &parents));
        }

        (offset..end)
            .map(|index| {
                let commit = repo.find_commit(self.order[index])?;
                let author = commit.author();
                Ok(GraphRow {
                    id: commit.id().to_string(),
                    summary: lossy(commit.summary_bytes().unwrap_or_default()),
                    author_name: lossy(author.name_bytes()),
                    author_email: lossy(author.email_bytes()),
                    time: author.when().seconds(),
                    layout: self.rows[index].clone(),
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lane(lane: u32, color: u32) -> LaneRef {
        LaneRef { lane, color }
    }

    #[test]
    fn linear_history_stays_in_one_lane() {
        let mut layout = LaneLayout::new();

        let tip = layout.place(3, &[2]);
        assert_eq!((tip.lane, tip.color), (0, 0));
        assert!(tip.incoming.is_empty());
        assert_eq!(tip.outgoing, [lane(0, 0)]);

        let middle = layout.place(2, &[1]);
        assert_eq!(middle.incoming, [lane(0, 0)]);
        assert_eq!(middle.outgoing, [lane(0, 0)]);

        let root = layout.place(1, &[]);
        assert_eq!(root.incoming, [lane(0, 0)]);
        assert!(root.outgoing.is_empty());
        assert!(root.passing.is_empty());
    }

    #[test]
    fn merged_branch_gets_its_own_lane_and_rejoins_at_the_fork() {
        let mut layout = LaneLayout::new();

        // 4 merges 3 (feature) into 2 (main); both fork from 1.
        let merge = layout.place(4, &[2, 3]);
        assert_eq!(merge.lane, 0);
        assert_eq!(merge.outgoing, [lane(0, 0), lane(1, 1)]);

        let feature = layout.place(3, &[1]);
        assert_eq!((feature.lane, feature.color), (1, 1));
        assert_eq!(feature.passing, [lane(0, 0)]);
        assert_eq!(feature.outgoing, [lane(1, 1)]);

        let main = layout.place(2, &[1]);
        assert_eq!((main.lane, main.color), (0, 0));
        assert_eq!(main.passing, [lane(1, 1)]);
        assert_eq!(main.outgoing, [lane(0, 0)]);

        let fork = layout.place(1, &[]);
        assert_eq!((fork.lane, fork.color), (0, 0));
        assert_eq!(fork.incoming, [lane(0, 0), lane(1, 1)]);
        assert!(fork.passing.is_empty());
    }

    #[test]
    fn merge_parent_already_awaited_reuses_its_lane() {
        let mut layout = LaneLayout::new();

        layout.place(5, &[3]);
        // 4 is another tip that merges 3, which lane 0 is already waiting for.
        let merge = layout.place(4, &[2, 3]);
        assert_eq!(merge.lane, 1);
        assert_eq!(merge.passing, [lane(0, 0)]);
        assert_eq!(merge.outgoing, [lane(1, 1), lane(0, 0)]);
    }

    #[test]
    fn freed_lane_is_reused_by_the_next_tip() {
        let mut layout = LaneLayout::new();

        layout.place(1, &[]);
        let unrelated = layout.place(2, &[]);
        assert_eq!((unrelated.lane, unrelated.color), (0, 1));
        assert!(unrelated.passing.is_empty());
    }
}
