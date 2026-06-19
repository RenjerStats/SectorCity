// На релизе прячем консольное окно на Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    sectorcity_lib::run()
}
