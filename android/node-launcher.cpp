#include <node.h>
#include <signal.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <unistd.h>

int main(int argc, char** argv) {
    const char* parent = getenv("LH_ANDROID_PARENT_PID");
    if (parent == nullptr || prctl(PR_SET_PDEATHSIG, SIGKILL) != 0
        || getppid() != strtol(parent, nullptr, 10)) {
        return 1;
    }
    return node::Start(argc, argv);
}
