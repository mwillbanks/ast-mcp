from pathlib import Path as FilePath
import json
class Service(BaseService, Audited):
    def run(self):
        return FilePath("x")
