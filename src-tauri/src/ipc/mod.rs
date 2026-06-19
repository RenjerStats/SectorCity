//! Граница IPC: контракт данных и команды Tauri.

mod commands;
mod contract;

pub use commands::{get_level, get_node_detail, search, start_scan};
pub use contract::{Category, NodeFlag, ScanNode};
