#include <vector>
class Base {};
class Service : public Base { public: int run() { return helper(); } private: int hidden(); };
