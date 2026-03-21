from fastapi import APIRouter
from core.validator.checker import validate_fault_tree
from models.schemas import FaultTree, ValidationResult

router = APIRouter()

@router.post("/", response_model=ValidationResult)
def validate(fault_tree: FaultTree):
    result = validate_fault_tree(fault_tree)
    return ValidationResult(**result)
