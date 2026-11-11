// A Windows Job Object that ends the server when the launcher ends, however it ends. Force-killing the
// launcher closes its handle to the job, and the job then ends every process in it.

use std::ffi::c_void;
use std::mem::{size_of, zeroed};
use std::os::windows::io::AsRawHandle;
use std::process::Child;
use std::ptr::null;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

// The job's handle. It is closed when this is dropped, which ends the processes in the job.
pub struct Job(HANDLE);

impl Job {
    // A new job whose processes end when its last handle closes.
    pub fn kill_on_close() -> Result<Job, String> {
        // SAFETY: the calls take null for every optional pointer, and the information struct is the size given.
        unsafe {
            let handle = CreateJobObjectW(null(), null());
            if handle.is_null() {
                return Err("the job for the server cannot be created".to_string());
            }
            let job = Job(handle);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let set = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION as *const c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if set == 0 {
                return Err("the job for the server cannot be set up".to_string());
            }
            Ok(job)
        }
    }

    // Puts the child process in the job. Fails if the process cannot be added.
    pub fn assign(&self, child: &Child) -> Result<(), String> {
        // SAFETY: both handles are valid for the duration of the call; the child's handle belongs to the child.
        let assigned = unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE) };
        if assigned == 0 {
            return Err("the server cannot be added to the job".to_string());
        }
        Ok(())
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        // SAFETY: the handle was created by CreateJobObjectW and is closed only here.
        unsafe {
            CloseHandle(self.0);
        }
    }
}
