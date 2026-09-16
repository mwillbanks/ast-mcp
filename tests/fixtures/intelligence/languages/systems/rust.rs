use std::fmt;
pub trait Runnable { fn run(&self); }
pub struct Service;
impl Runnable for Service { fn run(&self) { println!("café"); } }
