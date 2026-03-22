from fastapi import APIRouter
from backend.core.validator.checker import validate_fault_tree
from backend.models.schemas import FaultTree, ValidationResult

router = APIRouter(tags=["故障树校验"])

@router.post("/", response_model=ValidationResult)
def validate(fault_tree: FaultTree):
    result = validate_fault_tree(fault_tree)
    return ValidationResult(**result)
